import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("run --json delivers native progress while the provider response is still open", async () => {
  // Given a real native runtime with a provider stream that waits for the consumer.
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-streaming-"));
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [{ key: "fixture", type: "llm",
      capabilities: { trained_for_tool_use: true, vision: false }, loaded_instances: [{ id: "fixture", config: { context_length: 200000 } }] }] });
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller;
      controller.enqueue(encoder.encode('data: {"id":"one","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"안녕하세요 🌱"},"finish_reason":null}]}\n\n'));
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const proc = spawn(process.execPath, ["src/cli.ts", "run", "--root", "fixtures/tiny", "--state-dir", dir,
    "--base-url", `http://127.0.0.1:${server.port}/v1`, "--task", "Say hello", "--json"],
    { cwd: join(import.meta.dir, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", resolve);
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => { errors += chunk; });
  proc.stdout.setEncoding("utf8");
  const progress = new Promise<void>((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error(`No streamed progress before provider completion: ${errors}`)), 15000);
    let progressSeen = false;
    proc.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!progressSeen && output.includes('"type":"message_update"')) {
        progressSeen = true;
        if (deadline) clearTimeout(deadline);
        resolve();
      }
    });
  });
  const finish = () => {
    stream?.enqueue(encoder.encode('data: {"id":"one","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    stream?.close();
    stream = undefined;
  };
  try {
    // When the native model emits a partial response, before allowing it to finish.
    await progress;
    // Then the consumer already has progress, and receives one complete final result.
    expect(proc.exitCode).toBeNull();
    finish();
    expect(await closed).toBe(0);
    const events: unknown[] = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    const terminal = events.filter(event => typeof event === "object" && event !== null && "type" in event && event.type === "agent_end");
    expect(terminal).toHaveLength(1);
    expect(JSON.stringify(terminal)).toContain("안녕하세요 🌱");
    expect(output).not.toContain('"type":"omo_mini_status"');
  } finally {
    if (deadline) clearTimeout(deadline);
    try {
      if (proc.exitCode === null && proc.signalCode === null) {
        if (process.platform === "win32") {
          const killer = Bun.spawn(["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"], { stdout: "pipe", stderr: "pipe" });
          const [code, out, err] = await Promise.all([killer.exited, new Response(killer.stdout).text(), new Response(killer.stderr).text()]);
          if (code !== 0 && proc.exitCode === null && proc.signalCode === null) throw new Error(`Owned CLI cleanup failed: ${out} ${err}`);
        } else proc.kill();
      }
      await closed;
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 40000);
