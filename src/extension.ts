import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { MiniError } from "./local.ts";
import { checkProviderRequest, identity, responseState } from "./policy.ts";

// Loaded after the actual OmO plugin. Native tools, resources, TUI, and sessions remain upstream-owned.
export default function localProfile(pi: ExtensionAPI): void {
  const allowed = identity(process.env);
  const status = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) =>
    ctx.ui.setStatus("omo-mini", `LOCAL ${allowed.model} | ${allowed.context} ctx | ${allowed.root}`);
  pi.on("session_start", (_event, ctx) => status(ctx));
  pi.on("model_select", (_event, ctx) => status(ctx));
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nLocal omo-mini profile: You are running as ${allowed.model} at ${allowed.baseUrl} with loaded context ${allowed.context}; workspace ${allowed.root}. These are runtime facts, not repository facts. Keep tool calls focused, verify edits with tests, and report uncertainty and errors explicitly. No cloud fallback.`,
  }));
  pi.on("tool_result", (event) => ({
    content: event.content.map(part => part.type === "text" && part.text.length > 6000
      ? { ...part, text: `${part.text.slice(0, 6000)}\n[Tool output truncated by local profile]` } : part),
  }));
  pi.on("before_provider_request", (event) => {
    try {
      checkProviderRequest(event.model, event.payload, allowed);
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
