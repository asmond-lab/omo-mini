import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Frame = { readonly type: string; readonly id?: string; readonly command?: string; readonly success?: boolean;
  readonly data?: { readonly sessionFile?: string; readonly cancelled?: boolean }; readonly messages?: unknown };

// The real omo-mini entry launches the real OmO/Senpi RPC runtime. The local model HTTP wire is the only fake.
test("native multi-turn sessions retain context, /new isolates it and /resume restores it", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/v0/models") return Response.json({ data: [{ id: "fixture-local", state: "loaded", type: "llm", loaded_context_length: 200000, capabilities: ["tool_use"] }] });
    if (pathname === "/v1/chat/completions") {
      requests.push(await request.json());
      return new Response('data: {"id":"one","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ACK"},"finish_reason":null}]}\n\ndata: {"id":"one","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("Not Found", { status: 404 });
  } });
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-rpc-"));
  const proc = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", "fixtures/tiny", "--state-dir", dir, "--base-url", `http://127.0.0.1:${server.port}/v1`],
    { cwd: join(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
  const listeners = new Set<(event: Frame) => void>();
  const frames: Frame[] = [];
  let buffer = "";
  let errors = "";
  proc.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (line.startsWith("{")) {
        const frame: Frame = JSON.parse(line);
        frames.push(frame);
        for (const listener of listeners) listener(frame);
      }
      newline = buffer.indexOf("\n");
    }
  });
  let nextId = 0;
  function send(type: string, rest: Record<string, unknown> = {}): Promise<Frame> {
    const id = String(++nextId);
    const answer = wait(frame => frame.type === "response" && frame.id === id);
    proc.stdin.write(JSON.stringify({ id, type, ...rest }) + "\n");
    return answer;
  }
  function wait(match: (event: Frame) => boolean): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(onFrame); reject(new Error(`RPC frame timeout: ${errors.slice(-600)}`)); }, 30000);
      const onFrame = (frame: Frame) => { if (match(frame)) { clearTimeout(timer); listeners.delete(onFrame); resolve(frame); } };
      listeners.add(onFrame);
    });
  }
  async function prompt(message: string) {
    const idle = wait(frame => frame.type === "agent_idle");
    const accepted = await send("prompt", { message });
    expect(accepted.success).toBe(true);
    await idle;
  }
  try {
    const initial = await send("get_state");
    expect(initial.success).toBe(true);
    const saved = initial.data?.sessionFile;
    expect(saved).toBeTruthy();
    await prompt("Remember this public sentinel: CERULEAN-PAW-781.");
    await prompt("What was the public sentinel?");
    expect(JSON.stringify(requests.at(-1))).toContain("CERULEAN-PAW-781");
    const fresh = await send("new_session");
    expect(fresh.data?.cancelled).toBe(false);
    await prompt("Answer OK. Do not refer to any previous conversation.");
    expect(JSON.stringify(requests.at(-1))).not.toContain("CERULEAN-PAW-781");
    const restored = await send("switch_session", { sessionPath: saved });
    expect(restored.data?.cancelled).toBe(false);
    await prompt("Repeat the sentinel from the earlier session.");
    expect(JSON.stringify(requests.at(-1))).toContain("CERULEAN-PAW-781");
    expect(frames.some(frame => frame.type === "agent_idle")).toBe(true);
  } finally {
    proc.stdin.end();
    if (proc.exitCode === null) proc.kill();
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 160000);
