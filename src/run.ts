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
  let consecutiveMisses = 0;
  let finalOnly = false;
  let finalCoverage: string | undefined;
  let observedEvidence = false;
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
      const coverage = records.filter(record => record.name === "search_files" && record.result.startsWith("No matches in scanned files"))
        .map(record => record.result).at(-1);
      const guidance = ((consecutiveMisses >= 4 && requests >= 4) || (consecutiveMisses >= 2 && requests >= 7)) && coverage ?
        `Search has made no progress. ${coverage}. Answer now without tools. State only what the scanned scope supports; never assert full absence if coverage is incomplete or files were skipped.` : undefined;
      const effectiveContext = guidance ? { ...context, messages: [...context.messages,
        { role: "user" as const, content: [{ type: "text" as const, text: guidance }], timestamp: Date.now() }] } : context;
      try {
        if (requests > 8) rejection = "Maximum of 8 model requests reached";
        else if (failures >= 3) rejection = "Maximum of 3 tool errors reached";
        else if (config.signal?.aborted) rejection = "Task cancelled before request";
        else if (finalOnly) rejection = "No progress after final answer request";
        else {
          const request = { system: prompt, tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), messages: effectiveContext.messages };
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
      if (guidance) { finalOnly = true; finalCoverage = coverage; }
      return streamSimple(model, effectiveContext, { ...options, apiKey: "local", ...(guidance ? { toolChoice: "none" as const } : {}) });
    },
  });
  agent.subscribe(event => {
    if (event.type === "tool_execution_end") {
      const text = event.result.content?.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n") ?? "";
      records.push({ name: event.toolName, result: text.slice(0, 12000), isError: event.isError });
      if (event.isError) failures++;
      if (event.toolName === "search_files" && !event.isError && text.startsWith("No matches in scanned files")) consecutiveMisses++;
      else { consecutiveMisses = 0; if (!event.isError) observedEvidence = true; }
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
  let answer = assistant?.role === "assistant" ? assistant.content.filter(c => c.type === "text").map(c => c.text).join(String.fromCharCode(10)) : "";
  // A model can ignore the instruction and assert global absence. Never report that when coverage was limited.
  if (finalOnly && !observedEvidence && finalCoverage &&
      (finalCoverage.includes("coverage: incomplete") || !finalCoverage.includes("; 0 oversized files")) && assistant?.stopReason === "stop") {
    answer = `No matching evidence was found in scanned eligible files. Search incomplete: ${finalCoverage}`;
  }
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
