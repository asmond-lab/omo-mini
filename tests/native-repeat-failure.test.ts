import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FailedActionGuard } from "../src/policy.ts";

type Frame = { type: string; id?: string; success?: boolean; willRetry?: boolean; isError?: boolean; toolCallId?: string; method?: string; message?: string; messages?: { role: string; stopReason?: string; errorMessage?: string; content?: { type: string; text?: string }[] }[] };
type Wire = { messages: { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }[] };

test("failed-action guard permits changed actions, real progress and turn reset but bounds persistent retries", () => {
  const guard = new FailedActionGuard();
  guard.call("one", "bash", { command: "fail" }); guard.result("one", true);
  expect(guard.call("two", "bash", { command: "fail" })?.terminate).toBe(false);
  expect(guard.call("three", "bash", { command: "fail" })?.terminate).toBe(false);
  expect(guard.call("four", "bash", { command: "fail" })?.terminate).toBe(true);
  expect(guard.call("changed", "bash", { command: "different" })).toBeUndefined();
  guard.result("changed", true);
  expect(guard.call("old-failure", "bash", { command: "fail" })?.block).toBe(true);
  guard.call("progress", "read", { path: "public.txt" });
  guard.result("progress", false); // no stdout is still success
  expect(guard.call("recheck", "bash", { command: "fail" })).toBeUndefined();
  guard.result("recheck", true);
  expect(guard.call("different-tool", "powershell", { command: "fail" })).toBeUndefined();
  guard.reset();
  expect(guard.call("new-turn", "bash", { command: "fail" })).toBeUndefined();
});

test("native repeated failed action is blocked, alternative completes, and a new user turn retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-repeat-"));
  const failed = `bun -e "require('fs').appendFileSync('failed.txt','x');process.exit(49)"`;
  const alternative = `bun -e "require('fs').appendFileSync('alternative.txt','ok')"`;
  const requests: Wire[] = [];
  let nextCall = 0;
  let secondCalls = 0;
  let persistentRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/v0/models") return Response.json({ data: [{ id: "repeat-local", state: "loaded", type: "llm", loaded_context_length: 69376, capabilities: ["tool_use"] }] });
    const wire = await request.json() as Wire;
    requests.push(wire);
    const persistent = wire.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Persistent turn"));
    const turnTwo = wire.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("New user turn"));
    const command = persistent ? (persistentRequests++, failed) : turnTwo ? (++secondCalls === 1 ? failed : undefined) : requests.length <= 3 ? failed : requests.length === 4 ? alternative : undefined;
    const delta = command ? { tool_calls: [{ index: 0, id: `repeat-${++nextCall}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] } : { content: turnTwo ? "The retry failed; no work completed." : "The alternative completed." };
    const finish = command ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: "repeat", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "repeat", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const proc = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", join(root, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
  const listeners = new Set<(frame: Frame) => void>();
  const toolEnds: { id: string | undefined; isError: boolean | undefined }[] = [];
  let buffer = ""; let errors = "";
  proc.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (line.startsWith("{")) { const frame = JSON.parse(line) as Frame; if (frame.type === "tool_execution_end") toolEnds.push({ id: frame.toolCallId, isError: frame.isError }); for (const listener of listeners) listener(frame); }
      at = buffer.indexOf("\n");
    }
  });
  function wait(match: (frame: Frame) => boolean): Promise<Frame> {
    return new Promise((accept, reject) => {
      const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timeout); listeners.delete(listener); accept(frame); } };
      const timeout = setTimeout(() => { listeners.delete(listener); reject(new Error(`RPC timeout: ${errors.slice(-1000)}`)); }, 60000);
      listeners.add(listener);
    });
  }
  try {
    for (const [id, message] of [["1", "Stop repeating the failed command; try a different method."], ["2", "New user turn: retry the failed command once, and report failure truthfully."]] as const) {
      const end = wait(frame => frame.type === "agent_end" && !frame.willRetry);
      const ack = wait(frame => frame.type === "response" && frame.id === id);
      proc.stdin.write(JSON.stringify({ type: "prompt", id, message }) + "\n");
      expect((await ack).success).toBe(true);
      const last = (await end).messages?.filter(item => item.role === "assistant").at(-1);
      expect(last?.stopReason, `${JSON.stringify(last)} ${errors}`).toBe("stop");
    }
    const persistentEnd = wait(frame => frame.type === "agent_end" && !frame.willRetry);
    const notice = wait(frame => frame.type === "extension_ui_request" && frame.method === "notify" && typeof frame.message === "string");
    const persistentAck = wait(frame => frame.type === "response" && frame.id === "3");
    proc.stdin.write(JSON.stringify({ type: "prompt", id: "3", message: "Persistent turn: try the same failed action repeatedly." }) + "\n");
    expect((await persistentAck).success).toBe(true);
    const persistentLast = (await persistentEnd).messages?.filter(item => item.role === "assistant").at(-1);
    expect(persistentRequests).toBe(4);
    expect(persistentLast?.stopReason, JSON.stringify(persistentLast)).not.toBe("stop");
    const terminalNotice = (await notice).message;
    expect(terminalNotice?.length).toBeGreaterThan(0);
    const failureCount = (await readFile(join(root, "failed.txt"), "utf8")).length;
    expect(failureCount).toBe(3); // one failed physical execution per user turn
    expect(await readFile(join(root, "alternative.txt"), "utf8")).toBe("ok");
    const first = requests[0]!.messages;
    expect(first.at(-1)?.role).toBe("user");
    expect(JSON.stringify(first.at(-1)?.content)).toContain("Stop repeating");
    const history = requests[3]!.messages;
    const calls = history.filter(message => message.role === "assistant" && message.tool_calls?.some(call => call.function.name === "bash"));
    expect(calls.length).toBe(3);
    const results = history.filter(message => message.role === "tool");
    expect(results.length).toBe(3);
    expect(results.map(message => message.tool_call_id)).toEqual(calls.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
    expect(JSON.stringify(results)).toContain("49");
    expect(results[1]?.content).not.toEqual(results[0]?.content);
    expect(toolEnds.filter(event => event.isError).length).toBeGreaterThanOrEqual(3);
    expect(calls.map(message => message.tool_calls?.[0]?.function.arguments)).toEqual(Array(3).fill(JSON.stringify({ command: failed })));
    if (process.env["OMO_REPEAT_EVIDENCE_DIR"]) await writeFile(join(process.env["OMO_REPEAT_EVIDENCE_DIR"], "fake-wire.json"), JSON.stringify({ firstRequestRoles: first.map(message => message.role), correction: first.at(-1)?.content, callArguments: calls.map(message => message.tool_calls?.[0]?.function.arguments), pairs: results.map(message => message.tool_call_id), results: results.map(message => message.content), toolEnds, physicalFailureExecutions: failureCount, alternativeBytes: 2, persistentRequests, persistentTerminal: persistentLast?.stopReason, terminalNotice }, null, 2));
  } finally {
    const exit = new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("RPC child did not exit")), 10000);
      proc.once("exit", () => { clearTimeout(timer); accept(); });
    });
    proc.stdin.end(); if (proc.exitCode === null) proc.kill();
    await exit;
    server.stop(true); await rm(root, { recursive: true, force: true });
  }
}, 150000);
