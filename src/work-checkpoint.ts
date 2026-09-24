import type { ExtensionAPI } from "@code-yeongyu/senpi";

// Session-only recovery for native compaction's deterministic fallback, which can
// discard goal/todo actions and their observed results when summarization fails.
const ENTRY = "omo-mini.work-checkpoint";
type Observation = { id: string; tool: string; result: string };
type Work = { version: 1; root: string; goal?: string; blocker?: string; todo?: string; observed?: Observation[] };
type StoredWork = Omit<Work, "observed"> & { observed?: Observation[] | Observation };
type BranchEntry = { type: string; customType?: string; data?: unknown };
type SessionContext = { cwd: string; sessionManager: { getBranch(): BranchEntry[]; getHeader(): { cwd: string } | null } };
const short = (text: string, limit: number) => text.slice(0, limit);
function isObservation(item: unknown): item is Observation {
  return item !== null && typeof item === "object" &&
    typeof (item as Observation).id === "string" && (item as Observation).id.length <= 128 &&
    typeof (item as Observation).tool === "string" && (item as Observation).tool.length <= 32 &&
    typeof (item as Observation).result === "string" && (item as Observation).result.length <= 512;
}
function isWork(data: unknown, root: string): data is StoredWork {
  if (!data || typeof data !== "object") return false;
  const value = data as StoredWork;
  return value.version === 1 && value.root === root &&
    (value.goal === undefined || typeof value.goal === "string" && value.goal.length <= 512) &&
    (value.blocker === undefined || typeof value.blocker === "string" && value.blocker.length <= 256) &&
    (value.todo === undefined || typeof value.todo === "string" && value.todo.length <= 800) &&
    (value.observed === undefined || (Array.isArray(value.observed)
      ? value.observed.length <= 3 && value.observed.every(isObservation)
      : isObservation(value.observed))); // Earlier v1 writer saved one observation, not an array.
}
export function registerWorkCheckpoint(pi: ExtensionAPI, root: string) {
  let current: Work = { version: 1, root };
  let failure: string | undefined;
  let rootFailure: string | undefined;
  let invalidEntryId: string | undefined;
  let warnedEntryId: string | undefined;
  const restore = (ctx: SessionContext) => {
    current = { version: 1, root };
    failure = undefined;
    rootFailure = undefined;
    invalidEntryId = undefined;
    const header = ctx.sessionManager.getHeader();
    if (ctx.cwd !== root || header && header.cwd !== root) {
      rootFailure = "Selected session workspace differs from the local project"; return;
    }
    const entry = [...ctx.sessionManager.getBranch()].reverse().find(item => item.type === "custom" && item.customType === ENTRY);
    if (entry && !isWork(entry.data, root)) { failure = "Invalid local work checkpoint; derived state ignored and conversation retained"; invalidEntryId = "id" in entry ? String(entry.id) : undefined; return; }
    if (entry) {
      const saved = entry.data as StoredWork;
      current = { version: 1, root,
        ...(saved.goal === undefined ? {} : { goal: saved.goal }),
        ...(saved.blocker === undefined ? {} : { blocker: saved.blocker }),
        ...(saved.todo === undefined ? {} : { todo: saved.todo }),
        ...(saved.observed === undefined ? {} : { observed: (Array.isArray(saved.observed) ? saved.observed : [saved.observed])
          .map(({ id, tool, result }) => ({ id, tool, result })) }),
      };
    }
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
  const projection = (ctx: SessionContext & { ui: { notify(message: string, level: "warning"): void } }) => {
    restore(ctx);
    if (failure) {
      if (invalidEntryId !== warnedEntryId) { ctx.ui.notify(failure, "warning"); warnedEntryId = invalidEntryId; }
      return "\n\nLocal work checkpoint was invalid and omitted. Use the selected conversation and verify actual tool results before claiming completion.";
    }
    return current.goal || current.todo || current.observed
      ? `\n\n<session_work_checkpoint>\n${JSON.stringify(current)}\nOnly observed tool results with call IDs are execution evidence; goal/todo are plans. Resume the next open todo.\n</session_work_checkpoint>` : "";
  };
  return { projection, rootFailure: () => rootFailure };
}
