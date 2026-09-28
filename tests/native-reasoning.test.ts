import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

const messageSchema = z.object({ role: z.string(), content: z.unknown().optional(), reasoningContent: z.string().optional() }).passthrough();
const wireSchema = z.object({ messages: z.array(messageSchema) });
const frameSchema = z.object({ type: z.string(), id: z.string().optional(), success: z.boolean().optional(), willRetry: z.boolean().optional(), data: z.object({ messages: z.array(messageSchema).optional() }).passthrough().optional() });
type Frame = z.infer<typeof frameSchema>;

test("repeated planning reasoning triggers one transient recovery without rewriting native history", async () => {
  // Given: two tool-using model replies with the same long synthetic reasoning.
  const base = await mkdtemp(join(tmpdir(), "omo-mini-reasoning-"));
  const root = join(base, "project"), state = join(base, "state");
  await mkdir(join(root, ".omo"), { recursive: true });
  await Bun.write(join(root, "small.txt"), "SMALL-READ-RESULT\n");
  await Bun.write(join(root, ".omo", "omo.json"), JSON.stringify({ memory: {
    reflection: { enabled: false }, facts: { enabled: false }, dream: { enabled: false },
    recall: { enabled: false }, nudge: { enabled: false },
  } }));
  const planning = "SYNTHETIC-PLAN-CHECK-".repeat(12);
  const requests: z.infer<typeof wireSchema>[] = [];
  let firstTurnCalls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v0/models") return Response.json({ data: [{ id: "fixture-native", state: "loaded", type: "llm", loaded_context_length: 69376, capabilities: ["tool_use"] }] });
    if (path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const wire = wireSchema.parse(await request.json()); requests.push(wire);
    const firstTurn = JSON.stringify(wire.messages).includes("First turn: read the small file twice");
    const call = firstTurn && ++firstTurnCalls <= 2;
    const delta = call ? { reasoning_content: planning, tool_calls: [{ index: 0, id: `reasoning-read-${firstTurnCalls}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "small.txt" }) } }] } : { content: "Done." };
    const finish = call ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: "reasoning-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "reasoning-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const proc = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", errors = ""; const frames: Frame[] = [], listeners = new Set<(frame: Frame) => void>();
  proc.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let at = buffer.indexOf("\n");
    while (at >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (line.startsWith("{")) { const frame = frameSchema.parse(JSON.parse(line)); frames.push(frame); for (const listener of listeners) listener(frame); }
      at = buffer.indexOf("\n");
    }
  });
  const wait = (match: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
    const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timer); listeners.delete(listener); accept(frame); } };
    const timer = setTimeout(() => { listeners.delete(listener); reject(Error(`RPC timeout: ${errors.slice(-800)} ${JSON.stringify(frames.slice(-4))}`)); }, 60000);
    listeners.add(listener);
  });
  let nextId = 0;
  async function send(type: string, extra: Record<string, unknown> = {}, idle = false): Promise<Frame> {
    const id = String(++nextId), ack = wait(frame => frame.type === "response" && frame.id === id);
    const end = idle ? wait(frame => frame.type === "agent_end" && !frame.willRetry) : undefined;
    proc.stdin.write(JSON.stringify({ type, id, ...extra }) + "\n");
    const response = await ack; if (end) await end;
    expect(response.success, `${type}: ${errors}`).toBe(true);
    return response;
  }
  try {
    // When: native read results separate two otherwise identical planning paragraphs.
    await send("prompt", { message: "First turn: read the small file twice, then finish." }, true);
    expect(firstTurnCalls).toBe(3);
    const third = requests[2];
    expect(third).toBeDefined();
    const history = await send("get_messages");
    const messages = JSON.stringify(history.data?.messages ?? []);
    expect(messages.split(planning).length - 1).toBe(2);
    expect(messages).toContain("SMALL-READ-RESULT");
    expect(messages).toContain("reasoning-read-1");
    expect(messages).toContain("reasoning-read-2");
    expect(messages).not.toContain("<local_reasoning_recovery>");
    const thirdUsers = third?.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("<local_reasoning_recovery>")) ?? [];
    // Then: only one ephemeral guidance message appears and durable messages retain original reasoning.
    expect(thirdUsers).toHaveLength(1);
    const before = requests.length;
    await send("prompt", { message: "Second turn: answer Done." }, true);
    expect(JSON.stringify(requests.slice(before))).not.toContain("<local_reasoning_recovery>");
    await send("new_session");
    const fresh = requests.length;
    await send("prompt", { message: "Fresh session: answer Done." }, true);
    expect(JSON.stringify(requests.slice(fresh))).not.toContain("<local_reasoning_recovery>");
  } finally {
    const exit = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(Error("RPC exit timeout")); }, 10000);
      proc.once("exit", () => { clearTimeout(timer); accept(); });
    });
    proc.stdin.end(); if (proc.exitCode === null) proc.kill(); await exit;
    server.stop(true);
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep) || !base.split(/[\\/]/).at(-1)?.startsWith("omo-mini-reasoning-")) throw Error("Cleanup escaped owned temp directory");
    await rm(base, { recursive: true, force: true });
  }
}, 120000);
