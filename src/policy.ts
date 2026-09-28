import { MiniError } from "./local.ts";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@code-yeongyu/senpi";
import type { Skill } from "@code-yeongyu/senpi";
import { join } from "node:path";
import { LOCAL_PROVIDER } from "./profile.ts";
import { toolActionKey } from "./tool-action.ts";

export type LocalIdentity = { readonly model: string; readonly baseUrl: string; readonly context: number; readonly root: string; readonly loaded?: boolean };
export function identity(env: NodeJS.ProcessEnv): LocalIdentity {
  const model = env["OMO_MINI_MODEL"];
  const baseUrl = env["OMO_MINI_BASE_URL"];
  const root = env["OMO_MINI_ROOT"];
  const context = Number(env["OMO_MINI_CONTEXT"]);
  const loaded = env["OMO_MINI_LOADED"] !== "0";
  if ((!model && loaded) || !baseUrl || !root || !Number.isInteger(context) || context < 0)
    throw new MiniError("profile", "Invalid omo-mini local model profile");
  return { model: model ?? "", baseUrl, context, root, ...(loaded ? {} : { loaded: false }) };
}

export function checkProviderRequest(model: { readonly provider: string; readonly id: string; readonly baseUrl: string; readonly api: string } | undefined, allowed: LocalIdentity): void {
  if (allowed.loaded === false) throw new MiniError("model_selection", "No local model loaded. Select a downloaded model with /model before inference");
  if (!model || model.provider !== LOCAL_PROVIDER || model.id !== allowed.model || model.baseUrl !== allowed.baseUrl || model.api !== "openai-completions")
    throw new MiniError("local_only", `Blocked nonlocal provider request (${model?.provider ?? "unknown"}/${model?.id ?? "unknown"})`);
  // Native Senpi owns usage-based compaction and provider overflow recovery.
  // Serialized JSON bytes are not tokens and must not override that lifecycle.
}

export const MAX_TOOL_ERRORS = 5;

export function compactPrompt(options: { cwd: string; memoryHome?: string; selectedTools?: string[]; toolSnippets?: Record<string, string>; promptGuidelines?: string[]; appendSystemPrompt?: string; contextFiles?: { path: string; content: string }[]; skills?: Skill[] }, allowed: LocalIdentity, incoming = ""): string {
  const tools = options.selectedTools ?? [];
  const snippets = tools.filter(name => options.toolSnippets?.[name]).map(name => `- ${name}: ${options.toolSnippets![name]}`).join("\n");
  const instructions = options.contextFiles?.map(file => `<project_instructions path=${JSON.stringify(file.path)}>\n${file.content}\n</project_instructions>`).join("\n") ?? "";
  // The plugin and builtin todo hooks may run before this hook. Retain only
  // their live sections, never the entire upstream static prompt.
  // A marked memory projection is valid only for one path-safe Native identity.
  // Remove an invalid marked block without dropping surrounding Native text.
  const scopedIncoming = incoming.replace(/<!-- senpi-memory:([^\r\n]*?):begin -->[\s\S]*?<!-- senpi-memory:\1:end -->/gu,
    (block, agent: string) => /^[\p{L}\p{M}\p{N}_-]+$/u.test(agent) ? block : "");
  const memory = scopedIncoming.match(/<!-- senpi-memory:([\p{L}\p{M}\p{N}_-]+):begin -->[\s\S]*?<!-- senpi-memory:\1:end -->/u);
  const memoryAgent = memory?.[1];
  const memoryDir = options.memoryHome && memoryAgent ? join(options.memoryHome, "agents", memoryAgent, "repo") : undefined;
  const projection = memoryDir ? (memory?.[0] ?? "").replaceAll("$MEMORY_DIR", () => memoryDir) : memory?.[0] ?? "";
  // Native owns bundled/user/approved project skills. Memory-repo skills can be
  // created after session_start, so discover only the current memory identity.
  const nativeSkills = options.skills ?? [];
  const memorySkills = memoryDir ? loadSkillsFromDir({ dir: join(memoryDir, "skills"), source: "path" }).skills
    .filter(skill => !nativeSkills.some(existing => existing.filePath === skill.filePath)) : [];
  const skillCatalog = formatSkillsForPrompt([...nativeSkills, ...memorySkills]
    .map(skill => ({ ...skill, filePath: skill.filePath.replaceAll("\\", "/") })));
  const taskGuidance = scopedIncoming.match(/<Task_Management>[\s\S]*?<\/Task_Management>/)?.[0];
  const evalExamples = [
    ['display(await tool_schema("find"));', "Inspect the Native find schema"],
    ['display(await tool.grep({ pattern: "TODO", path: "." }));', "Search workspace text"],
    ['display(await tool.bash({ command: "bun test" }));', "Run local tests"],
  ].map(([code, summary]) => `<eval_arguments>${JSON.stringify({ language: "js", code, summary })}</eval_arguments>`).join(" ");
  const toolUseCheckpoint = "Before a tool call: call a directly exposed tool (such as read/edit/write/ls/find) directly, never inside eval; use eval only to call tool.<name> for a helper that is not directly exposed (such as grep or bash) or a task's authorized command, never for ad hoc code or experiments, and send a task's exact command form as that literal one-line call. Omit optional arguments instead of passing null, and keep the edits of one edit call disjoint by merging nearby changes into one entry, copying each oldText from the file's current text (re-read the region after an edit or a failed edit), not from memory. Read files, not directories; to locate text in a large file, grep it instead of paging with read, and if a search returns exactly its match limit (grep's default is 100), narrow the pattern (for example, exclude the frequent value) instead of paging. tool_search discovers deferred capabilities, not workspace files. " +
    "For eval run, supply together the selected language (js for JS cells), a nonblank summary, and code that is exactly one statement, display(await tool.<name>({...})) or display(await tool_schema(\"<name>\")), with no imports, variables, globalThis, fs or other statements (tool is already a global). " +
    "Use only a published todo op (init/start/done/rm/drop/append/view); any other op, such as update, fails. " +
    "bash_input/bash_output do not run commands; they need a bash_id returned by a background bash call you started in this session, never a guessed ID or a command; without one there is no shell to poll. Do not repeat an identical successful call (such as get_goal or todo init) without new information. " +
    "After a failed validation or permission, correct the tool call or report the blocker instead of repeating it or trying an unapproved shell; verify edits with the exact authorized test when one is requested.";
  const executionContract = [
    "tool_search discovers deferred tool capabilities and schemas, not workspace files or text. For local files, list with Native ls, find filenames with find, search contents with grep, then read regular files (not directories); do these simple lookups yourself instead of delegating them to a subagent (task). Inside eval, reach helpers that are not directly exposed through tool.<name> rather than ad hoc runtime imports.",
    `For an unfamiliar tool inspect its live schema with a literal tool_schema name inside eval. Each eval run needs language, code and a nonblank summary; these are complete examples (one cell per action): ${evalExamples}`,
    "A tool being available does not authorize its use: follow the current user's task scope and host permissions, including for shell, delegation and external paths. Task IDs are not bash_ids; never invent or interpolate IDs.",
  ].join("\n");
  // Replace only Native's machine skill tables, not extension/system instructions.
  // Formatting the combined list once gives every root one unambiguous rN alias.
  if (scopedIncoming.trim()) {
    let nativePrompt = memoryDir ? scopedIncoming.replaceAll("$MEMORY_DIR", () => memoryDir) : scopedIncoming;
    const roots = nativePrompt.match(/<skill_roots>[\s\S]*?<\/skill_roots>/)?.[0];
    const listed = nativePrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0];
    if (roots && listed && skillCatalog) {
      const mergedRoots = skillCatalog.match(/<skill_roots>[\s\S]*?<\/skill_roots>/)?.[0];
      const mergedSkills = skillCatalog.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0];
      nativePrompt = nativePrompt.replace(roots, mergedRoots!).replace(listed, mergedSkills!);
    } else if ((roots && !listed) || (!roots && listed)) {
      throw new MiniError("skills", "Incomplete Native skill catalog");
    } else if (!roots && skillCatalog) nativePrompt += `\n\n${skillCatalog}`;
    return [`Local inference only. Active model: ${allowed.model || "not loaded"}. Workspace: ${allowed.root}.`, toolUseCheckpoint, nativePrompt, executionContract].join("\n\n");
  }
  return [`You are OmO, a local coding assistant. Model: ${allowed.model}. Loaded context: ${allowed.context}. Workspace: ${allowed.root}. These are runtime facts, not repository facts.`,
    toolUseCheckpoint,
    "For greetings or questions solely about the loaded model or workspace, answer directly using the exact runtime model ID and canonical workspace path above; do not call tools or inspect environment variables. On Windows, a shell's /c/... path is only an alias, not the canonical C:\\... workspace path. Answer conversation-history questions from this conversation, not workspace searches. For code tasks use native tools as needed; verify changes. State uncertainty and failures honestly. If information is absent after a focused search, say it is not found rather than searching indefinitely. No cloud fallback.",
    "Native tools (subject to host permissions):", tools.join(", "), snippets,
    "Use create_goal/update_goal/get_goal and todo for ongoing work; keep the goal, observed tool results, blockers and next action current. Resume the selected session for its task; /new starts a fresh task. An intention or todo marked done is not proof of execution. Write only intentionally durable same-project facts with memory; /memory inspects and memory delete forgets. /memfs init initializes local storage when needed. Never sync or publish memory.",
    ...(projection ? [projection] : []), ...(skillCatalog ? [skillCatalog] : []), ...(taskGuidance ? [taskGuidance] : []),
    ...(options.promptGuidelines?.length ? ["Tool guidelines:", ...options.promptGuidelines.filter(line => !line.startsWith("Record durable facts,"))] : []),
    ...(options.appendSystemPrompt ? [options.appendSystemPrompt] : []),
    ...(instructions ? ["Project instructions:", instructions] : []),
    `Current working directory: ${options.cwd}`, executionContract].join("\n\n");
}

export class TurnBudget {
  toolErrors = 0;
  reset(): void { this.toolErrors = 0; }
  toolResult(isError: boolean): void { if (isError) this.toolErrors++; else this.toolErrors = 0; }
  admission(): string | undefined {
    if (this.toolErrors >= MAX_TOOL_ERRORS) return `Local turn stopped after ${MAX_TOOL_ERRORS} consecutive tool errors; answer not completed`;
    return undefined;
  }
}

// Only observed native errors establish a failed action. A successful coding action
// may change the environment; inspection and task/memory bookkeeping cannot establish
// remediation of a failed command. No command-text inference is attempted.
const PROGRESS_TOOLS = new Set(["bash", "powershell", "edit", "write"]);
export class FailedActionGuard {
  private readonly failed = new Map<string, { readonly tool: string; readonly fileState: string | undefined }>();
  private blocked = 0;
  private readonly pending = new Map<string, { readonly action: string; readonly tool: string; readonly fileState: string | undefined }>();
  get stopped(): boolean { return this.blocked >= 3; }

  reset(): void { this.failed.clear(); this.blocked = 0; this.pending.clear(); }
  call(id: string, tool: string, input: Record<string, unknown>, options?: { readonly fileState?: string }): { block: true; reason: string; terminate: boolean } | undefined {
    const action = toolActionKey(tool, input);
    if (this.failed.get(action)?.fileState === options?.fileState && this.failed.has(action)) {
      this.blocked++;
      return { block: true, reason: "Repeated failed tool action blocked before execution. The previous execution returned an error; use a materially different tool or arguments, or report that the work is unfinished.", terminate: this.blocked >= 3 };
    }
    this.failed.delete(action);
    this.pending.set(id, { action, tool, fileState: options?.fileState });
    return undefined;
  }
  result(id: string, isError: boolean): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return; // A blocked call still receives a native tool-result pair.
    this.pending.delete(id);
    if (isError) this.failed.set(pending.action, { tool: pending.tool, fileState: pending.fileState });
    else if (PROGRESS_TOOLS.has(pending.tool)) {
      for (const [action, failure] of this.failed) {
        if (failure.tool === "bash" || failure.tool === "powershell") this.failed.delete(action);
      }
      this.blocked = 0;
    }
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
