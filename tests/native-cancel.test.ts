import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native RPC abort stops an open local provider stream and reports cancellation", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/v0/models") return Response.json({ data: [{ id: "fixture", state: "loaded", type: "llm", loaded_context_length: 200000, capabilities: ["tool_use"] }] });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"id":"one","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Partial answer"},"finish_reason":null}]}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-abort-"));
  const proc = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", "fixtures/tiny", "--state-dir", dir,
    "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: join(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
  const listeners = new Set<(frame: { type: string; id?: string; success?: boolean; aborted?: boolean }) => void>();
  let buffer = ""; let errors = "";
  proc.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let i = buffer.indexOf("\n");
    while (i >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (line.startsWith("{")) { const frame = JSON.parse(line); for (const listener of listeners) listener(frame); }
      i = buffer.indexOf("\n");
    }
  });
  function wait(match: (frame: { type: string; id?: string; success?: boolean; aborted?: boolean }) => boolean) {
    return new Promise<{ type: string; id?: string; success?: boolean; aborted?: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => { listeners.delete(onFrame); reject(new Error(`Native abort timed out: ${errors.slice(-500)}`)); }, 30000);
      const onFrame = (frame: { type: string; id?: string; success?: boolean; aborted?: boolean }) => {
        if (match(frame)) { clearTimeout(timeout); listeners.delete(onFrame); resolve(frame); }
      };
      listeners.add(onFrame);
    });
  }
  try {
    const partial = wait(frame => frame.type === "message_update");
    proc.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: "Say a greeting" }) + "\n");
    await partial;
    const ended = wait(frame => frame.type === "agent_end");
    const abort = wait(frame => frame.type === "response" && frame.id === "abort");
    proc.stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n");
    expect((await abort).success).toBe(true);
    expect((await ended).aborted).toBe(true);
  } finally {
    proc.stdin.end(); if (proc.exitCode === null) proc.kill();
    server.stop(true); await rm(dir, { recursive: true, force: true });
  }
}, 70000);
