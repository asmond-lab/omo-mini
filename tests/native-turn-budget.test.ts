import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_TURN_REQUESTS } from "../src/policy.ts";

test("native request cap rejects before transport, settles, and resets for the next user input", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === "/api/v0/models") return Response.json({ data: [{ id: "bounded-local", state: "loaded", type: "llm", loaded_context_length: 69376, capabilities: ["tool_use"] }] });
    const body = await req.json() as { messages: { role: string; content: unknown }[] };
    requests++;
    const secondTurn = body.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Second user turn"));
    const delta = secondTurn ? { content: "Second turn completed." } : { tool_calls: [{ index: 0, id: `tool-${requests}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `public-${requests}.txt` }) } }] };
    const finish = secondTurn ? "stop" : "tool_calls";
    return new Response(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const root = await mkdtemp(join(tmpdir(), "omo-mini-turn-cap-"));
  const proc = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", join(root, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
  type Frame = { type: string; id?: string; success?: boolean; willRetry?: boolean; messages?: { role: string; stopReason?: string; errorMessage?: string; content?: { text?: string }[] }[] };
  const listeners = new Set<(frame: Frame) => void>();
  let buffer = ""; let errors = "";
  proc.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let at = buffer.indexOf("\n");
    while (at >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.startsWith("{")) {
      const frame = JSON.parse(line) as Frame; for (const listener of listeners) listener(frame);
    } at = buffer.indexOf("\n"); }
  });
  function wait(match: (frame: Frame) => boolean): Promise<Frame> {
    return new Promise((accept, reject) => {
      const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timeout); listeners.delete(listener); accept(frame); } };
      const timeout = setTimeout(() => { listeners.delete(listener); reject(new Error(`Native turn timeout: ${errors.slice(-500)}`)); }, 45000);
      listeners.add(listener);
    });
  }
  try {
    for (let index = 1; index <= MAX_TURN_REQUESTS; index++) await writeFile(join(root, `public-${index}.txt`), `Public value ${index}.\n`);
    for (const [index, prompt] of ["Read public.txt repeatedly", "Second user turn: say completed"].entries()) {
      const done = wait(frame => frame.type === "agent_end" && !frame.willRetry);
      const acknowledgement = wait(frame => frame.type === "response" && frame.id === String(index));
      proc.stdin.write(JSON.stringify({ type: "prompt", id: String(index), message: prompt }) + "\n");
      expect((await acknowledgement).success).toBe(true);
      const end = await done;
      const last = end.messages?.filter(message => message.role === "assistant").at(-1);
      if (index === 0) {
        expect(requests, `${JSON.stringify(last)} ${errors.slice(-1200)}`).toBe(MAX_TURN_REQUESTS);
        expect(last?.stopReason).toBe("error");
        expect(last?.errorMessage).toContain("answer not completed");
      } else {
        expect(requests).toBe(MAX_TURN_REQUESTS + 1);
        expect(last?.stopReason).toBe("stop");
        expect(last?.content?.some(part => part.text?.includes("Second turn completed"))).toBe(true);
      }
    }
  } finally {
    proc.stdin.end(); if (proc.exitCode === null) proc.kill();
    server.stop(true); await rm(root, { recursive: true, force: true });
  }
}, 100000);
