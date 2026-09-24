import type { ExtensionAPI } from "@code-yeongyu/senpi";

// Session-only recovery for native compaction's deterministic fallback, which can
// discard goal/todo actions and their observed results when summarization fails.
const ENTRY = "omo-mini.work-checkpoint";
type Work = { version: 1; root: string; goal?: string; blocker?: string; todo?: string; observed?: { id: string; tool: string; result: string }[] };
type BranchEntry = { type: string; customType?: string; data?: unknown };
const short = (text: string, limit: number) => text.slice(0, limit);
function isWork(data: unknown, root: string): data is Work {
  if (!data || typeof data !== "object") return false;
  const value = data as Work;
  return value.version === 1 && value.root === root &&
    (value.goal === undefined || typeof value.goal === "string" && value.goal.length <= 512) &&
    (value.blocker === undefined || typeof value.blocker === "string" && value.blocker.length <= 256) &&
    (value.todo === undefined || typeof value.todo === "string" && value.todo.length <= 800) &&
    (value.observed === undefined || Array.isArray(value.observed) && value.observed.length <= 3 && value.observed.every(item =>
      item !== null && typeof item === "object" && typeof item.id === "string" && item.id.length <= 128 &&
      typeof item.tool === "string" && item.tool.length <= 32 && typeof item.result === "string" && item.result.length <= 512));
}
export function registerWorkCheckpoint(pi: ExtensionAPI, root: string) {
  let current: Work = { version: 1, root };
  let failure: string | undefined;
  const restore = (ctx: { cwd: string; sessionManager: { getBranch(): BranchEntry[] } }) => {
    current = { version: 1, root };
    failure = undefined;
    if (ctx.cwd !== root) { failure = "Work checkpoint workspace differs from selected session"; return; }
    const entry = [...ctx.sessionManager.getBranch()].reverse().find(item => item.type === "custom" && item.customType === ENTRY);
    if (entry && !isWork(entry.data, root)) { failure = "Invalid work checkpoint in selected session"; return; }
    current = entry ? entry.data as Work : { version: 1, root };
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("tool_result", event => {
    if (event.isError) return;
    if (event.toolName === "create_goal" && typeof event.input["objective"] === "string") current.goal = short(event.input["objective"], 512);
    else if (event.toolName === "update_goal" && event.input["status"] === "complete") { delete current.goal; delete current.blocker; }
    else if (event.toolName === "update_goal" && event.input["status"] === "blocked" && typeof event.input["reason"] === "string") current.blocker = short(event.input["reason"], 256);
    else if (event.toolName === "todo") current.todo = short(event.content.filter(part => part.type === "text").map(part => part.text).join("\n"), 800);
    else if (["read", "bash", "powershell", "edit", "write"].includes(event.toolName)) current.observed = [...(current.observed ?? []), {
      id: short(event.toolCallId, 128), tool: event.toolName,
      result: short(event.content.filter(part => part.type === "text").map(part => part.text).join("\n"), 512),
    }].slice(-3);
    else return;
    pi.appendEntry(ENTRY, { ...current });
  });
  const projection = (ctx: { cwd: string; sessionManager: { getBranch(): BranchEntry[] } }) => {
    restore(ctx);
    return current.goal || current.todo || current.observed
      ? `\n\n<session_work_checkpoint>\n${JSON.stringify(current)}\nOnly observed tool results with call IDs are execution evidence; goal/todo are plans. Resume the next open todo.\n</session_work_checkpoint>` : "";
  };
  return { projection, failure: () => failure };
}
