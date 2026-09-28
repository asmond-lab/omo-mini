import { fileURLToPath } from "node:url";
import { z } from "zod";
import { convertToLlm, type ExtensionAPI } from "@code-yeongyu/senpi";
import { MINI_IDENTITY, MiniError } from "./local.ts";
import { checkProviderRequest, compactPrompt, FailedActionGuard, identity, responseState, TurnBudget, type LocalIdentity } from "./policy.ts";
import { registerWorkCheckpoint } from "./work-checkpoint.ts";
import { ReasoningRecovery, REASONING_RECOVERY } from "./reasoning-recovery.ts";
import { inspectionState, ToolProgressGuard } from "./tool-progress.ts";

export const statusText = (allowed: LocalIdentity): string => allowed.loaded === false
  ? `${MINI_IDENTITY} LOCAL | Select a downloaded model with /model | ${allowed.root}`
  : `${MINI_IDENTITY} LOCAL ${allowed.model} | ${allowed.context} ctx | ${allowed.root}`;

// Native publishes eval `language` as optional, and the local model drops it. Require it on the outgoing
// wire schema only: Native's own eval validation and argument parsing stay unchanged.
const wireRequest = z.object({ tools: z.array(z.unknown()) }).passthrough();
const wireEvalTool = z.object({ type: z.literal("function"), function: z.object({ name: z.literal("eval"), parameters: z.object({
  properties: z.object({ language: z.object({}).passthrough() }).passthrough(), required: z.array(z.string()).optional() }).passthrough() }).passthrough() }).passthrough();
function requireEvalLanguage(payload: unknown): unknown {
  const request = wireRequest.safeParse(payload);
  if (!request.success) return undefined;
  return { ...request.data, tools: request.data.tools.map(tool => {
    const parsed = wireEvalTool.safeParse(tool);
    if (!parsed.success) return tool;
    const { parameters } = parsed.data.function;
    return { ...parsed.data, function: { ...parsed.data.function, parameters: { ...parameters, required: [...new Set([...parameters.required ?? [], "language"])] } } };
  }) };
}

// Loaded after the actual OmO plugin. Native tools, resources, TUI, and sessions remain upstream-owned.
export default function localProfile(pi: ExtensionAPI): void {
  let allowed = identity(process.env);
  process.env["OMO_MEMORY_RUN_SUPERVISOR_PATH"] = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./reflection-supervisor.ts" : "./reflection-supervisor.js", import.meta.url));
  const memoryHome = process.env["OMO_MEMORY_HOME"];
  const budget = new TurnBudget();
  const failures = new FailedActionGuard();
  const progress = new ToolProgressGuard();
  const reasoning = new ReasoningRecovery();
  const work = registerWorkCheckpoint(pi, allowed.root);
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || !("messages" in payload) || !Array.isArray(payload.messages)) return;
    const latest = payload.messages.at(-1);
    if (latest?.role !== "user") return;
    const compaction = ctx.sessionManager.buildContextEntries().find(entry => entry.type === "compaction");
    if (compaction?.type !== "compaction") return;
    const summary = ctx.sessionManager.buildSessionContext().messages.find(message => message.role === "compactionSummary");
    if (summary?.summary !== compaction.summary) return;
    const nativeMessage = convertToLlm([summary])[0];
    if (nativeMessage?.role !== "user") return;
    const checkpoint = work.recovery(ctx, compaction, latest.content, nativeMessage.content);
    if (checkpoint) return { ...payload, messages: [...payload.messages, { role: "user", content: checkpoint }] };
  });
  let pendingUserInputs = 0;
  pi.on("input", event => { if (event.source !== "extension") pendingUserInputs++; });
  pi.on("tool_execution_end", event => budget.toolResult(event.isError));
  pi.on("tool_call", async (event, ctx) => {
    const state = await inspectionState(event.toolName, event.input, ctx.cwd);
    return progress.call(event.toolCallId, event.toolName, event.input, state)
      ?? failures.call(event.toolCallId, event.toolName, event.input, state);
  });
  const status = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) =>
    ctx.ui.setStatus("omo-mini", statusText(allowed));
  pi.on("session_start", (_event, ctx) => { reasoning.reset(); progress.reset(); failures.reset(); budget.reset(); status(ctx); });
  pi.on("session_tree", () => { reasoning.reset(); progress.reset(); failures.reset(); budget.reset(); });
  pi.on("model_select", () => { reasoning.reset(); progress.reset(); failures.reset(); budget.reset(); });
  pi.on("turn_end", event => {
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason !== "toolUse" || event.toolResults.length === 0) { reasoning.reset(); return; }
    reasoning.observe(event.message.timestamp, event.message.content.flatMap(part => part.type === "thinking" ? [part.thinking] : []));
  });
  pi.on("context", event => {
    const latest = event.messages.findLast(message => message.role === "user" || message.role === "assistant");
    // Steered user input can arrive inside an active run without before_agent_start.
    if (latest?.role === "user") { budget.reset(); failures.reset(); reasoning.reset(); progress.reset(); return; }
    const notices = [progress.consume(event.messages), reasoning.consume(event.messages) ? REASONING_RECOVERY : undefined].filter(text => text !== undefined);
    if (notices.length === 0) return;
    return { messages: [...event.messages, { role: "user", content: [{ type: "text", text: notices.join("\n\n") }], timestamp: Date.now() }] };
  });
  pi.registerCommand("local-profile", {
    description: "Show the full local model and canonical workspace root",
    handler: async (_args, ctx) => {
      const root = Array.from(allowed.root);
      const lines = [`Local model: ${allowed.model}`, `Loaded context: ${allowed.context}`, "Canonical root:"];
      for (let index = 0; index < root.length; index += 60) lines.push(root.slice(index, index + 60).join(""));
      ctx.ui.setWidget("omo-mini-profile", lines);
    },
  });
  pi.on("before_agent_start", (event, ctx) => {
    allowed = identity(process.env); status(ctx);
    if (pendingUserInputs > 0) { pendingUserInputs--; budget.reset(); failures.reset(); reasoning.reset(); progress.reset(); }
    return { systemPrompt: compactPrompt({ ...event.systemPromptOptions, ...(memoryHome === undefined ? {} : { memoryHome }) }, allowed, event.systemPrompt) + work.projection(ctx) };
  });
  pi.on("tool_result", (event) => {
    failures.result(event.toolCallId, event.isError);
    progress.result(event.toolCallId, event.isError, event.content);
  });
  pi.on("before_provider_request", (event) => {
    try {
      allowed = identity(process.env);
      if (work.rootFailure()) return { action: "reject", reason: work.rootFailure() };
      checkProviderRequest(event.model, allowed);
      const limit = budget.admission();
      if (limit) return { action: "reject", reason: limit };
    } catch (error) {
      if (error instanceof MiniError) return { action: "reject", reason: error.message };
      throw error;
    }
    return requireEvalLanguage(event.payload);
  });
  pi.on("agent_end", (event, ctx) => {
    if (event.willRetry) return;
    const notice = progress.stopped && !event.aborted
      ? "Local turn stopped: unchanged file inspection repeatedly blocked; work not completed. Reuse the observed result and address the remaining task."
      : failures.stopped && !event.aborted
      ? "Local turn stopped: repeated failed action blocked before execution; work not completed. Try a different tool or arguments."
      : responseState(event.messages.filter(message => message.role === "assistant"), event.aborted);
    if (notice) {
      if (ctx.hasUI) ctx.ui.notify(notice, "warning");
      else console.error(`omo-mini: ${notice}`);
    }
  });
}
