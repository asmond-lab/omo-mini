import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_TOOL_ERRORS } from "../src/policy.ts";

test("native work completes beyond 12 requests while tool-error stops reset for new user input", async () => {
  const reads = 16;
  let requests = 0;
  let failedRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const endpointPath = new URL(req.url).pathname;
    if (endpointPath === "/api/v1/models") return Response.json({ models: [{ key: "bounded-local", type: "llm",
      capabilities: { trained_for_tool_use: true, vision: false }, loaded_instances: [{ id: "bounded-local", config: { context_length: 69376 } }] }] });
    if (endpointPath !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    const body = await req.json() as { messages: { role: string; content: unknown }[] };
    requests++;
    const prompt = JSON.stringify(body.messages.findLast(message => message.role === "user")?.content);
    const failingTurn = prompt?.includes("Failing user turn");
    const recoveryTurn = prompt?.includes("Recovery user turn");
    if (failingTurn) failedRequests++;
    const path = failingTurn ? `missing-${failedRequests}.txt` : !recoveryTurn && requests <= reads ? `public-${requests}.txt` : undefined;
    const delta = path ? { tool_calls: [{ index: 0, id: `tool-${requests}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } }] }
      : { content: recoveryTurn ? "Recovery turn completed." : "All 16 reads completed." };
    const finish = path ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const root = await mkdtemp(join(tmpdir(), "omo-mini-turn-cap-"));
  const proc = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", join(root, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
  type Frame = { type: string; id?: string; success?: boolean; willRetry?: boolean; isError?: boolean; messages?: { role: string; stopReason?: string; errorMessage?: string; content?: { text?: string }[] }[] };
  const listeners = new Set<(frame: Frame) => void>();
  const waitTimers = new Set<ReturnType<typeof setTimeout>>();
  const toolEnds: Frame[] = [];
  let buffer = ""; let errors = "";
  proc.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let at = buffer.indexOf("\n");
    while (at >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.startsWith("{")) {
      const frame = JSON.parse(line) as Frame;
      if (frame.type === "tool_execution_end") toolEnds.push(frame);
      for (const listener of listeners) listener(frame);
    } at = buffer.indexOf("\n"); }
  });
  function wait(match: (frame: Frame) => boolean): Promise<Frame> {
    return new Promise((accept, reject) => {
      const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timeout); waitTimers.delete(timeout); listeners.delete(listener); accept(frame); } };
      const timeout = setTimeout(() => { waitTimers.delete(timeout); listeners.delete(listener); reject(new Error(`Native turn timeout: ${errors.slice(-500)}`)); }, 45000);
      waitTimers.add(timeout);
      listeners.add(listener);
    });
  }
  try {
    for (let index = 1; index <= reads; index++) await writeFile(join(root, `public-${index}.txt`), `Public value ${index}.\n`);
    for (const [index, prompt] of ["Read all 16 public files and report completion", "Failing user turn: read distinct missing files", "Recovery user turn: say completed"].entries()) {
      const done = wait(frame => frame.type === "agent_end" && !frame.willRetry);
      const acknowledgement = wait(frame => frame.type === "response" && frame.id === String(index));
      proc.stdin.write(JSON.stringify({ type: "prompt", id: String(index), message: prompt }) + "\n");
      expect((await acknowledgement).success).toBe(true);
      const end = await done;
      const last = end.messages?.filter(message => message.role === "assistant").at(-1);
      if (index === 0) {
        expect(requests, `${JSON.stringify(last)} ${errors.slice(-1200)}`).toBe(reads + 1);
        expect(last?.stopReason).toBe("stop");
        expect(last?.content?.some(part => part.text?.includes("All 16 reads completed"))).toBe(true);
        expect(toolEnds.length).toBe(reads);
        expect(toolEnds.every(frame => frame.isError === false)).toBe(true);
      } else if (index === 1) {
        expect(failedRequests).toBe(MAX_TOOL_ERRORS);
        expect(last?.stopReason).toBe("error");
        expect(last?.errorMessage).toContain(`${MAX_TOOL_ERRORS} consecutive tool errors`);
        expect(toolEnds.filter(frame => frame.isError).length).toBe(MAX_TOOL_ERRORS);
      } else {
        expect(requests).toBe(reads + MAX_TOOL_ERRORS + 2);
        expect(last?.stopReason).toBe("stop");
        expect(last?.content?.some(part => part.text?.includes("Recovery turn completed"))).toBe(true);
      }
    }
  } finally {
    for (const timer of waitTimers) clearTimeout(timer);
    waitTimers.clear(); listeners.clear();
    try {
      proc.stdin.end();
      if (proc.exitCode === null && proc.signalCode === null) await new Promise<void>((accept, reject) => {
        let settled = false;
        const onExit = () => { if (settled) return; settled = true; clearTimeout(timer); proc.off("exit", onExit); accept(); };
        const timer = setTimeout(() => { if (settled) return; settled = true; proc.off("exit", onExit); proc.kill(); reject(new Error(`Native turn cleanup timed out (pid ${proc.pid}): ${errors.slice(-500)}`)); }, 10000);
        proc.once("exit", onExit);
        if (proc.exitCode !== null || proc.signalCode !== null) onExit();
      });
    } finally {
      try { server.stop(true); } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}, 100000);
