import { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { checkBudget, MiniError, sdkModel } from "./local.ts";
import type { LocalModel } from "./local.ts";
import { scopedTools, workspace } from "./tools.ts";

export type ToolRecord = { readonly name: string; readonly result: string; readonly isError: boolean };
export type RunResult = { readonly answer: string; readonly tools: readonly ToolRecord[]; readonly references: readonly string[];
  readonly elapsedMs: number; readonly usage: { readonly input: number; readonly output: number } | null;
  readonly reason: string; readonly error?: string; readonly requests: number; readonly requestBytes: readonly number[] };

const PROMPT = "You are omo-mini, a read-only workspace investigator. Search/read files before making claims. Cite file:line from observed tool output only. If evidence is absent, say so. Keep the answer concise.";
const GROUNDED = `${PROMPT} For each factual claim, give its observed file:line citation. Where versions conflict, identify the active source before concluding; do not invent citations.`;

export async function runTask(config: { readonly root: string; readonly task: string; readonly selected: LocalModel; readonly baseUrl: string;
  readonly images?: readonly ImageContent[]; readonly strategy?: "baseline" | "grounded"; readonly deadlineMs?: number; readonly signal?: AbortSignal }): Promise<RunResult> {
  const start = performance.now();
  const root = await workspace(config.root);
  const model = sdkModel(config.selected, config.baseUrl);
  const records: ToolRecord[] = [];
  const prompt = config.strategy === "grounded" ? GROUNDED : PROMPT;
  const requestBytes: number[] = [];
  let requests = 0;
  let failures = 0;
  let budgetFailure: string | undefined;
  let usageInput = 0;
  let usageOutput = 0;
  let hasUsage = false;
  const tools = scopedTools(root);
  const agent = new Agent({ initialState: { model, systemPrompt: prompt, tools },
    toolExecution: "sequential",
    streamFn: (_model, context, options) => {
      requests++;
      let rejection: string | undefined;
      try {
        if (requests > 8) rejection = "Maximum of 8 model requests reached";
        else if (failures >= 3) rejection = "Maximum of 3 tool errors reached";
        else if (config.signal?.aborted) rejection = "Task cancelled before request";
        else {
          const request = { system: prompt, tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), messages: context.messages };
          checkBudget(request, model.contextWindow);
          requestBytes.push(Buffer.byteLength(JSON.stringify(request), "utf8"));
        }
      } catch (error) {
        if (error instanceof MiniError) rejection = error.message;
        else throw error;
      }
      if (rejection) {
        budgetFailure = rejection;
        const stream = createAssistantMessageEventStream();
        const error = { role: "assistant" as const, content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error" as const, errorMessage: rejection, timestamp: Date.now() };
        stream.push({ type: "error", reason: "error", error });
        return stream;
      }
      return streamSimple(model, context, { ...options, apiKey: "local" });
    },
  });
  agent.subscribe(event => {
    if (event.type === "tool_execution_end") {
      const text = event.result.content?.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n") ?? "";
      records.push({ name: event.toolName, result: text.slice(0, 12000), isError: event.isError });
      if (event.isError) failures++;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage: Usage = event.message.usage;
      if (usage.totalTokens > 0) { hasUsage = true; usageInput += usage.input; usageOutput += usage.output; }
    }
  });
  const deadline = setTimeout(() => agent.abort(), config.deadlineMs ?? 90000);
  const onInterrupt = () => agent.abort();
  process.once("SIGINT", onInterrupt);
  config.signal?.addEventListener("abort", onInterrupt, { once: true });
  // A pre-aborted Agent.abort() is reset by prompt(); the streaming guard above persists.
  try {
    if (config.images?.length) await agent.prompt(config.task, [...config.images]);
    else await agent.prompt(config.task);
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", onInterrupt);
    config.signal?.removeEventListener("abort", onInterrupt);
  }
  const assistant = agent.state.messages.filter(m => m.role === "assistant").at(-1);
  const answer = assistant?.role === "assistant" ? assistant.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";
  const references = [...new Set(records.flatMap(record => {
    const lines = record.result.split("\n");
    const heading = record.name === "read_file" ? lines[0] : undefined;
    return lines.flatMap(line => {
      const search = /^(.+?:\d+):/.exec(line);
      const read = /^(\d+):/.exec(line);
      return search?.[1] ? [search[1].replaceAll("\\", "/")] : heading && read?.[1] ? [`${heading.replaceAll("\\", "/")}:${read[1]}`] : [];
    });
  }))].slice(0, 30);
  const reason = budgetFailure ? "error" : assistant?.role === "assistant" ? assistant.stopReason : "error";
  return { answer, tools: records, references, elapsedMs: Math.round(performance.now() - start),
    usage: hasUsage ? { input: usageInput, output: usageOutput } : null, reason,
    ...(budgetFailure || agent.state.errorMessage ? { error: budgetFailure ?? agent.state.errorMessage } : {}), requests, requestBytes };
}
