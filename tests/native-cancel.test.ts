import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native RPC abort stops an open local provider stream and reports cancellation", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [{ key: "fixture", type: "llm",
      capabilities: { trained_for_tool_use: true, vision: false }, loaded_instances: [{ id: "fixture", config: { context_length: 200000 } }] }] });
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
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
      const cleanup = () => { clearTimeout(timeout); listeners.delete(onFrame); proc.off("exit", onExit); };
      const onExit = () => { cleanup(); reject(new Error(`Native exited before abort event: ${errors.slice(-500)}`)); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Native abort timed out: ${errors.slice(-500)}`)); }, 30000);
      const onFrame = (frame: { type: string; id?: string; success?: boolean; aborted?: boolean }) => {
        if (match(frame)) { cleanup(); resolve(frame); }
      };
      listeners.add(onFrame);
      proc.once("exit", onExit);
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
    try {
      // Native reaches process.exit within ~160ms of EOF, but on a Windows runner the first Native process of a fresh profile
      // took 8.1-17.1s more to terminate (CI run 36453082769); 45s bounds that OS exit, not the product shutdown.
      proc.stdin.end();
      if (proc.exitCode === null && proc.signalCode === null) await new Promise<void>((accept, reject) => {
        let settled = false;
        const onExit = () => { if (settled) return; settled = true; clearTimeout(timer); proc.off("exit", onExit); accept(); };
        const timer = setTimeout(() => { if (settled) return; settled = true; proc.off("exit", onExit); proc.kill(); reject(new Error(`Native abort cleanup timed out (pid ${proc.pid}): ${errors.slice(-500)}`)); }, 45000);
        proc.once("exit", onExit);
        if (proc.exitCode !== null || proc.signalCode !== null) onExit();
      });
    } finally {
      try { server.stop(true); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  }
}, 70000);
