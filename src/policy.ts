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

export function responseState(messages: readonly { readonly role: "assistant"; readonly stopReason?: string; readonly errorMessage?: string; readonly content?: readonly { readonly type: string; readonly text?: string }[] }[], aborted = false): string | undefined {
  if (aborted) return "Cancelled";
  const last = messages.filter(message => message.role === "assistant").at(-1);
  if (!last) return "No assistant response";
  if (last.stopReason === "error") return `Model error: ${last.errorMessage ?? "provider request failed"}`;
  if (last.stopReason === "length") return "Model output reached its length limit";
  if (!last.content?.some(part => part.type === "text" && part.text?.trim())) return "Model returned an empty answer";
  return undefined;
}
