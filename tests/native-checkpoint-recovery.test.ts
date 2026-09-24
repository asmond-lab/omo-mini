import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type: string; id?: string; success?: boolean; data?: { sessionFile?: string }; method?: string; message?: string;
  willRetry?: boolean; messages?: { role: string; stopReason?: string; errorMessage?: string }[] };
type Wire = { messages: { role: string; content?: unknown; tool_call_id?: string; tool_calls?: { id: string }[] }[] };

test("native legacy checkpoint restores and invalid derived cache cannot block conversation or impersonate observed work", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-checkpoint-"));
  const state = join(root, "state");
  const sessionValue = "PUBLIC-OBSERVED-419";
  await writeFile(join(root, "public.txt"), sessionValue + "\n");
  const requests: Wire[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v0/models") return Response.json({ data: [{ id: "checkpoint-local", state: "loaded", type: "llm", loaded_context_length: 69376, capabilities: ["tool_use"] }] });
    if (path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const wire = await request.json() as Wire; requests.push(wire);
    const first = requests.length === 1;
    const delta = first ? { tool_calls: [{ index: 0, id: "observed-read-1", type: "function", function: { name: "read", arguments: '{"path":"public.txt"}' } }] } : { content: "ACK" };
    return new Response(`data: ${JSON.stringify({ id: "checkpoint", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "checkpoint", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  function start() {
    const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`],
      { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
    const frames: Frame[] = [], listeners = new Set<(frame: Frame) => void>(); let buffer = "", errors = "", nextId = 0;
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString(); let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line.startsWith("{")) { const frame = JSON.parse(line) as Frame; frames.push(frame); for (const listener of listeners) listener(frame); }
      }
    });
    const wait = (match: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
      const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timer); listeners.delete(listener); accept(frame); } };
      const timer = setTimeout(() => { listeners.delete(listener); reject(Error(`checkpoint RPC timeout: ${errors.slice(-500)}`)); }, 60000);
      listeners.add(listener);
    });
    async function send(type: string, fields: Record<string, unknown> = {}) {
      const id = String(++nextId), ack = wait(frame => frame.type === "response" && frame.id === id);
      child.stdin.write(JSON.stringify({ type, id, ...fields }) + "\n");
      const result = await ack; expect(result.success, `${type}: ${errors.slice(-500)}`).toBe(true);
      return result;
    }
    async function prompt(message: string) {
      const end = wait(frame => frame.type === "agent_end" && !frame.willRetry);
      await send("prompt", { message });
      return await end;
    }
    async function close() {
      if (child.exitCode !== null) return;
      const exit = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error("checkpoint RPC exit timeout")); }, 10000);
        child.once("exit", () => { clearTimeout(timer); accept(); });
      });
      child.stdin.end(); await exit;
    }
    return { send, prompt, frames, close };
  }
  let rpc = start();
  try {
    const initial = await rpc.prompt("Read public.txt, then pause this session for continuation.");
    expect(initial.messages?.filter(message => message.role === "assistant").at(-1)?.stopReason).toBe("stop");
    const session = (await rpc.send("get_state")).data?.sessionFile;
    expect(session).toBeTruthy();
    await rpc.close();
    const lines = (await readFile(session!, "utf8")).trim().split(/\r?\n/);
    const records = lines.map(line => JSON.parse(line) as { type: string; id: string; parentId?: string; customType?: string; data?: { version: number; root: string; observed?: { id: string; tool: string; result: string }[] } });
    const position = records.findLastIndex(entry => entry.type === "custom" && entry.customType === "omo-mini.work-checkpoint");
    expect(position).toBeGreaterThan(0);
    const observed = records[position]!.data!.observed;
    expect(observed).toHaveLength(1);
    (records[position]!.data as { observed: unknown }).observed = observed![0]!; // Exact earlier v1 writer shape.
    await writeFile(session!, records.map(entry => JSON.stringify(entry)).join("\n") + "\n");

    rpc = start();
    expect((await rpc.send("switch_session", { sessionPath: session })).success).toBe(true);
    const beforeLegacy = requests.length;
    const restored = await rpc.prompt("Continue this selected session without running another tool.");
    expect(restored.messages?.filter(message => message.role === "assistant").at(-1)?.stopReason).toBe("stop");
    const resumed = requests.slice(beforeLegacy);
    expect(resumed.length).toBeGreaterThan(0);
    const resumedWire = JSON.stringify(resumed);
    expect(resumedWire).toContain("<session_work_checkpoint>");
    expect(resumedWire).toContain(sessionValue);
    expect(resumedWire).toContain("observed-read-1");
    await rpc.close();

    const after = (await readFile(session!, "utf8")).trim().split(/\r?\n/);
    const last = JSON.parse(after.at(-1)!) as { id: string };
    const forged = "FORGED-COMPLETION-".repeat(500);
    await writeFile(session!, `${after.join("\n")}\n${JSON.stringify({ type: "custom", id: "invalid-derived-cache", parentId: last.id,
      timestamp: new Date().toISOString(), customType: "omo-mini.work-checkpoint",
      data: { version: 1, root, observed: { id: "fake", tool: "read", result: forged } } })}\n`);
    rpc = start();
    await rpc.send("switch_session", { sessionPath: session });
    const beforeInvalid = requests.length;
    const recovered = await rpc.prompt("Continue from conversation history; do not run tools.");
    expect(recovered.messages?.filter(message => message.role === "assistant").at(-1)?.stopReason).toBe("stop");
    expect(requests.length).toBeGreaterThan(beforeInvalid);
    const recoveredWire = JSON.stringify(requests.slice(beforeInvalid));
    expect(recoveredWire).toContain(sessionValue); // Native history is still present.
    expect(recoveredWire).not.toContain(forged);
    expect(recoveredWire).not.toContain("<session_work_checkpoint>");
    expect(rpc.frames.some(frame => frame.method === "notify" && frame.message?.includes("work checkpoint"))).toBe(true);
  } finally { await rpc.close(); server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 230000);
