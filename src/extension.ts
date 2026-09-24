import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { MiniError } from "./local.ts";
import { checkProviderRequest, compactPrompt, identity, responseState, TurnBudget } from "./policy.ts";

// Loaded after the actual OmO plugin. Native tools, resources, TUI, and sessions remain upstream-owned.
export default function localProfile(pi: ExtensionAPI): void {
  const allowed = identity(process.env);
  const budget = new TurnBudget();
  let pendingUserInputs = 0;
  pi.on("input", event => { if (event.source !== "extension") pendingUserInputs++; });
  pi.on("tool_execution_end", event => budget.toolResult(event.isError));
  const status = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) =>
    ctx.ui.setStatus("omo-mini", `LOCAL ${allowed.model} | ${allowed.context} ctx | ${allowed.root}`);
  pi.on("session_start", (_event, ctx) => status(ctx));
  pi.on("model_select", (_event, ctx) => status(ctx));
  pi.registerCommand("local-profile", {
    description: "Show the full local model and canonical workspace root",
    handler: async (_args, ctx) => {
      const root = Array.from(allowed.root);
      const lines = [`Local model: ${allowed.model}`, `Loaded context: ${allowed.context}`, "Canonical root:"];
      for (let index = 0; index < root.length; index += 60) lines.push(root.slice(index, index + 60).join(""));
      ctx.ui.setWidget("omo-mini-profile", lines);
    },
  });
  pi.on("before_agent_start", event => {
    if (pendingUserInputs > 0) { pendingUserInputs--; budget.reset(); }
    return { systemPrompt: compactPrompt(event.systemPromptOptions, allowed) };
  });
  pi.on("tool_result", (event) => ({
    content: event.content.map(part => part.type === "text" && part.text.length > 6000
      ? { ...part, text: `${part.text.slice(0, 6000)}\n[Tool output truncated by local profile]` } : part),
  }));
  pi.on("before_provider_request", (event) => {
    try {
      checkProviderRequest(event.model, event.payload, allowed);
      const limit = budget.admission();
      if (limit) return { action: "reject", reason: limit };
    } catch (error) {
      if (error instanceof MiniError) return { action: "reject", reason: error.message };
      throw error;
    }
  });
  pi.on("agent_end", (event, ctx) => {
    if (event.willRetry) return;
    const notice = responseState(event.messages.filter(message => message.role === "assistant"), event.aborted);
    if (notice) {
      if (ctx.hasUI) ctx.ui.notify(notice, "warning");
      else console.error(`omo-mini: ${notice}`);
    }
  });
}
