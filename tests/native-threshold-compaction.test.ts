import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stopOwnedWindowsTree } from "./native-context-recovery-owned-windows.ts";

type Message = { role: string; content?: unknown };
type Wire = { model: string; messages: Message[] };
type Frame = { type: string; willRetry?: boolean; result?: { details?: { schema?: string; failureKind?: string } };
  messages?: { role: string; stopReason?: string }[] };

const MODEL = "threshold-local";
const TASK_MARKER = "THRESHOLD-TASK-6123";
const TASK = `Read part-1.txt, part-2.txt and part-3.txt, then write answer.json with key token set to ${TASK_MARKER}.`;
const SUMMARY_MARKER = "THRESHOLD-SUMMARY-6124";
const FALLBACK_SCHEMA = "senpi.compaction.deterministic-fallback.v1";
const FALLBACK_MARKER = "[Deterministic compaction recovery checkpoint]";
const text = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
  ? content.map(part => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "").join("\n") : "";
// Every Native summarization prompt ends the request with a user turn asking for a <summary> block.
const isSummary = (wire: Wire) => wire.messages.at(-1)?.role === "user" && text(wire.messages.at(-1)?.content).includes("<summary>");
const bounded = async <T>(pending: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_accept, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
};

type Run = { agent: Wire[]; summaries: Wire[]; compaction: Frame; end: Frame };
async function thresholdRun(summaryFails: boolean, check: (run: Run) => void): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "omo-mini-threshold-"));
  const home = join(base, "home"), root = join(home, "work"), temp = join(home, "tmp");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(temp, { recursive: true })]);
  // About 5K estimated tokens per read: Mini's 4K keepRecentTokens retains only the newest pair, not the task.
  for (const part of [1, 2, 3]) await writeFile(join(root, `part-${part}.txt`), `part ${part}\n${"public fixture line\n".repeat(1000)}`);
  const agent: Wire[] = [], summaries: Wire[] = [];
  const sse = (delta: object, finish: string, usage?: object) => new Response([delta, {}].map((part, index) =>
    `data: ${JSON.stringify({ id: "threshold", object: "chat.completion.chunk", choices: [{ index: 0, delta: part, finish_reason: index ? finish : null }],
      ...(index && usage ? { usage } : {}) })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [{ key: MODEL, type: "llm", capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: MODEL, config: { context_length: 65536 } }] }] });
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    const wire = await request.json() as Wire;
    if (isSummary(wire)) {
      summaries.push(wire);
      return summaryFails
        ? Response.json({ error: { message: "fixture summary rejected", type: "invalid_request_error" } }, { status: 400 })
        : sse({ content: `<task-intent>\nORIGINAL_REQUEST: ${TASK}\n</task-intent>\n<summary>\n${SUMMARY_MARKER}\n</summary>` }, "stop");
    }
    agent.push(wire);
    const part = agent.length;
    if (part > 3) return sse({ content: "Finished." }, "stop");
    // The third turn reports the real run's pressure (62041 of 65536), so Native compacts before the next request.
    return sse({ tool_calls: [{ index: 0, id: `threshold-read-${part}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `part-${part}.txt` }) } }] },
      "tool_calls", part === 3 ? { prompt_tokens: 62041, completion_tokens: 16, total_tokens: 62057 } : undefined);
  } });
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", join(home, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`],
    { cwd: resolve(import.meta.dir, ".."), env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const closed = new Promise<void>(accept => { child.once("close", () => accept()); });
  const frames: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  let stderr = "", buffer = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      frames.push(frame);
      for (const listener of listeners) listener(frame);
    }
  });
  const wait = (label: string, match: (frame: Frame) => boolean) => {
    const frame = new Promise<Frame>((accept, reject) => {
      const done = () => { clearTimeout(timer); listeners.delete(onFrame); };
      const onFrame = (next: Frame) => { if (match(next)) { done(); accept(next); } };
      const fail = (reason: string) => { done(); reject(Error(`${label} ${reason}: ${stderr.slice(-800)} frames=${JSON.stringify(frames.slice(-4)).slice(0, 1600)}`)); };
      const timer = setTimeout(() => fail("deadline"), 90000);
      listeners.add(onFrame);
      void closed.then(() => fail("child closed"));
    });
    void frame.catch(() => {});
    return frame;
  };
  let primary: unknown;
  try {
    const compaction = wait("compaction_end", frame => frame.type === "compaction_end");
    const end = wait("agent_end", frame => frame.type === "agent_end" && frame.willRetry !== true);
    child.stdin.write(JSON.stringify({ type: "prompt", id: "1", message: TASK }) + "\n");
    check({ agent, summaries, compaction: await compaction, end: await end });
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  try {
    child.stdin.end();
    try { await bounded(closed, 10000, "threshold RPC child did not close"); }
    catch (error) {
      if (process.platform !== "win32" || child.pid === undefined || child.exitCode !== null) throw error;
      await stopOwnedWindowsTree(child.pid);
      await bounded(closed, 10000, "threshold RPC tree did not close");
    }
  } catch (error) { cleanup.push(error); child.kill(); }
  server.stop(true);
  if (cleanup.length === 0) await rm(base, { recursive: true, force: true }).catch((error: unknown) => { cleanup.push(error); });
  if (primary !== undefined && cleanup.length) throw new AggregateError([primary, ...cleanup], `threshold test and cleanup failed; scratch at ${base}`);
  if (primary !== undefined) throw primary;
  if (cleanup.length) throw new AggregateError(cleanup, `threshold cleanup failed; scratch at ${base}`);
}

const afterCompaction = (run: Run) => run.agent[3]?.messages ?? [];

test("threshold compaction sends its summary to the local model through Mini's guard", async () => thresholdRun(false, run => {
  expect({
    summaryModels: [...new Set(run.summaries.map(wire => wire.model))],
    schema: run.compaction.result?.details?.schema === FALLBACK_SCHEMA ? "fallback" : "summary",
    nextCarriesSummary: afterCompaction(run).some(message => text(message.content).includes(SUMMARY_MARKER)),
    stopReason: run.end.messages?.filter(message => message.role === "assistant").at(-1)?.stopReason,
  }).toEqual({ summaryModels: [MODEL], schema: "summary", nextCarriesSummary: true, stopReason: "stop" });
}), 120000);

test("a failed threshold summary keeps the latest user task in the next request", async () => thresholdRun(true, run => {
  const next = afterCompaction(run);
  expect({
    summaryModels: [...new Set(run.summaries.map(wire => wire.model))],
    schema: run.compaction.result?.details?.schema,
    failureKind: run.compaction.result?.details?.failureKind,
    taskMessageRetained: next.some(message => message.role === "user" && text(message.content) === TASK),
    taskInCheckpoint: next.some(message => message.role === "user" && text(message.content).includes(FALLBACK_MARKER) && text(message.content).includes(TASK)),
  }).toEqual({ summaryModels: [MODEL], schema: FALLBACK_SCHEMA, failureKind: "summarization-provider-failure",
    taskMessageRetained: false, taskInCheckpoint: true });
}), 120000);
