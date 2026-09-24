import { MiniError } from "./local.ts";
import { LOCAL_PROVIDER } from "./profile.ts";

export type LocalIdentity = { readonly model: string; readonly baseUrl: string; readonly context: number; readonly root: string };
export function identity(env: NodeJS.ProcessEnv): LocalIdentity {
  const model = env["OMO_MINI_MODEL"];
  const baseUrl = env["OMO_MINI_BASE_URL"];
  const root = env["OMO_MINI_ROOT"];
  const context = Number(env["OMO_MINI_CONTEXT"]);
  if (!model || !baseUrl || !root || !Number.isInteger(context) || context < 4096)
    throw new MiniError("profile", "Invalid omo-mini local model profile");
  return { model, baseUrl, context, root };
}

export function checkProviderRequest(model: { readonly provider: string; readonly id: string; readonly baseUrl: string; readonly api: string } | undefined, payload: unknown, allowed: LocalIdentity): number {
  if (!model || model.provider !== LOCAL_PROVIDER || model.id !== allowed.model || model.baseUrl !== allowed.baseUrl || model.api !== "openai-completions")
    throw new MiniError("local_only", `Blocked nonlocal provider request (${model?.provider ?? "unknown"}/${model?.id ?? "unknown"})`);
  // The native request is a serialized provider payload (including tool schemas), not a token
  // stream. On the loaded Qwen, 66 KB serialized produced ~9K input tokens. Using the old
  // UTF-8-byte count as tokens incorrectly rejected even a two-turn conversation. A 1.5-byte
  // token proxy plus 4096 framing and 3072 output reserve is deliberately >4x the observed
  // input usage; the endpoint remains authoritative if its tokenizer disagrees.
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const proxy = Math.ceil(bytes / 1.5) + 4096;
  if (proxy + 3072 > allowed.context)
    throw new MiniError("context_budget", `Request proxy ${proxy} plus 3072 output reserve exceeds loaded context ${allowed.context}; no request sent`);
  return proxy;
}

export const MAX_TURN_REQUESTS = 12;
export const MAX_TOOL_ERRORS = 5;

export function compactPrompt(options: { cwd: string; selectedTools?: string[]; toolSnippets?: Record<string, string>; promptGuidelines?: string[]; appendSystemPrompt?: string; contextFiles?: { path: string; content: string }[]; skills?: { name: string; description: string; filePath: string; disableModelInvocation: boolean }[] }, allowed: LocalIdentity): string {
  const tools = options.selectedTools ?? [];
  const snippets = tools.filter(name => options.toolSnippets?.[name]).map(name => `- ${name}: ${options.toolSnippets![name]}`).join("\n");
  const instructions = options.contextFiles?.map(file => `<project_instructions path=${JSON.stringify(file.path)}>\n${file.content}\n</project_instructions>`).join("\n") ?? "";
  const skills = options.skills?.filter(skill => !skill.disableModelInvocation).map(skill => `- ${skill.name}: ${skill.description} (${skill.filePath})`).join("\n") ?? "";
  return [`You are OmO, a local coding assistant. Model: ${allowed.model}. Loaded context: ${allowed.context}. Workspace: ${allowed.root}. These are runtime facts, not repository facts.`,
    "For greetings or questions solely about the loaded model or workspace, answer directly using the exact runtime model ID and canonical workspace path above; do not call tools or inspect environment variables. On Windows, a shell's /c/... path is only an alias, not the canonical C:\\... workspace path. Answer conversation-history questions from this conversation, not workspace searches. For code tasks use native tools as needed; verify changes. State uncertainty and failures honestly. If information is absent after a focused search, say it is not found rather than searching indefinitely. No cloud fallback.",
    "Native tools (subject to host permissions):", tools.join(", "), snippets,
    ...(options.promptGuidelines?.length ? ["Tool guidelines:", ...options.promptGuidelines] : []),
    ...(options.appendSystemPrompt ? [options.appendSystemPrompt] : []),
    ...(instructions ? ["Project instructions:", instructions] : []),
    ...(skills ? ["Available skills (read the file when relevant):", skills] : []),
    `Current working directory: ${options.cwd}`].join("\n\n");
}

export class TurnBudget {
  requests = 0;
  toolErrors = 0;
  reset(): void { this.requests = 0; this.toolErrors = 0; }
  toolResult(isError: boolean): void { if (isError) this.toolErrors++; else this.toolErrors = 0; }
  admission(): string | undefined {
    if (this.requests >= MAX_TURN_REQUESTS) return `Local turn stopped after ${MAX_TURN_REQUESTS} provider requests; answer not completed`;
    if (this.toolErrors >= MAX_TOOL_ERRORS) return `Local turn stopped after ${MAX_TOOL_ERRORS} consecutive tool errors; answer not completed`;
    this.requests++;
    return undefined;
  }
}

// Only observed native errors establish a failed action. A successful tool result
// clears the failure, allowing a recheck after intervening progress.
export class FailedActionGuard {
  private readonly failed = new Set<string>();
  private blocked = 0;
  private readonly pending = new Map<string, string>();
  get stopped(): boolean { return this.blocked >= 3; }

  reset(): void { this.failed.clear(); this.blocked = 0; this.pending.clear(); }
  call(id: string, tool: string, input: Record<string, unknown>): { block: true; reason: string; terminate: boolean } | undefined {
    const action = JSON.stringify([tool, input]);
    if (this.failed.has(action)) {
      this.blocked++;
      return { block: true, reason: "Repeated failed tool action blocked before execution. The previous execution returned an error; use a materially different tool or arguments, or report that the work is unfinished.", terminate: this.blocked >= 3 };
    }
    this.pending.set(id, action);
    return undefined;
  }
  result(id: string, isError: boolean): void {
    const action = this.pending.get(id);
    if (action === undefined) return; // A blocked call still receives a native tool-result pair.
    this.pending.delete(id);
    if (isError) this.failed.add(action);
    else { this.failed.clear(); this.blocked = 0; }
  }
}

export function responseState(messages: readonly { readonly role: "assistant"; readonly stopReason?: string; readonly errorMessage?: string; readonly content?: readonly { readonly type: string; readonly text?: string }[] }[], aborted = false): string | undefined {
  if (aborted) return "Cancelled";
  const last = messages.filter(message => message.role === "assistant").at(-1);
  if (!last) return "No assistant response";
  if (last.stopReason === "error") return `Model error: ${last.errorMessage ?? "provider request failed"}`;
  if (last.stopReason === "length") return "Model output reached its length limit";
  if (!last.content?.some(part => part.type === "text" && part.text?.trim())) return "Model returned an empty answer";
  return undefined;
}
