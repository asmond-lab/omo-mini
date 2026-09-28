import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type: string; id?: string; success?: boolean; method?: string; title?: string; options?: string[];
  toolCallId?: string; isError?: boolean; result?: { content?: unknown }; data?: Record<string, unknown> };
type Chat = { model?: string; messages?: { role?: string; tool_call_id?: string; content?: unknown }[] };

test("Native quick child after /model switch infers on the newly selected local instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-switch-child-"));
  const state = join(root, "state");
  const traffic: Chat[] = [], frames: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  const pending = new Set<(reason: Error) => void>();
  const childPrompt = "CHILD-ONLY-MARKER-882";
  const childAnswer = "CHILD-LOCAL-RESULT-882";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: ["alpha", "beta"].map(key => ({
      key, type: "llm", max_context_length: 131072, capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: `${key}-instance`, config: { context_length: 65536 } }],
    })) });
    if (path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = await request.json() as Chat;
    traffic.push(body);
    const resumed = body.messages?.some(m => m.role === "tool" && m.tool_call_id === "switch-task" && JSON.stringify(m.content).includes(childAnswer)) ?? false;
    const child = !resumed && body.messages?.some(m => m.role === "user" && JSON.stringify(m.content).includes(childPrompt));
    const delta = child ? { content: childAnswer } : resumed ? { content: "SWITCH-CHILD-DONE" }
      : { tool_calls: [{ index: 0, id: "switch-task", type: "function", function: { name: "task", arguments: JSON.stringify({
        category: "quick", task_summary: "Check the switched local child", prompt: `Respond ${childPrompt} with ${childAnswer} and no tools.`, run_in_background: false,
      }) } }] };
    return new Response(`data: ${JSON.stringify({ id: "switch-child", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "switch-child", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: child || resumed ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const processChild = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`],
    { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "", errors = "", nextId = 0;
  processChild.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  processChild.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      frames.push(frame);
      if (frame.type === "extension_ui_request" && frame.method === "select" && frame.title?.startsWith("Permission required: task\n")) {
        expect(frame.options).toContain("Allow once");
        processChild.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Allow once" }) + "\n");
      }
      for (const listener of listeners) listener(frame);
    }
  });
  const wait = (predicate: (frame: Frame) => boolean): Promise<Frame> => {
    const result = new Promise<Frame>((accept, reject) => {
      const clear = () => { clearTimeout(timer); listeners.delete(onFrame); processChild.off("exit", onExit); pending.delete(cancel); };
      const cancel = (reason: Error) => { clear(); reject(reason); };
      const onFrame = (frame: Frame) => { if (predicate(frame)) { clear(); accept(frame); } };
      const onExit = () => cancel(Error(`Native exited: ${errors.slice(-1000)}`));
      const timer = setTimeout(() => cancel(Error(`Native deadline: ${errors.slice(-1000)} ${JSON.stringify(traffic)}`)), 60000);
      listeners.add(onFrame); processChild.once("exit", onExit); pending.add(cancel);
    });
    // A failed earlier assertion must not produce a later unhandled rejection.
    void result.catch(() => {});
    return result;
  };
  const send = (type: string, extra: Record<string, unknown> = {}) => {
    const id = String(++nextId), response = wait(frame => frame.type === "response" && frame.id === id);
    processChild.stdin!.write(JSON.stringify({ id, type, ...extra }) + "\n");
    return response;
  };
  try {
    const selected = await send("set_model", { provider: "omo-mini-local", modelId: "beta" });
    expect(selected.success, JSON.stringify(selected)).toBe(true);
    expect(((await send("get_state")).data?.["model"] as { id: string }).id).toBe("beta-instance");
    const ended = wait(frame => frame.type === "agent_end");
    const taskEnd = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "switch-task");
    expect((await send("prompt", { message: "Delegate to quick then report its result." })).success).toBe(true);
    const result = await taskEnd;
    expect(result.isError, JSON.stringify(result.result)).toBe(false);
    expect(JSON.stringify(result.result?.content)).toContain(childAnswer);
    await ended;
    const childWire = traffic.find(body => body.messages?.some(m => m.role === "user" && JSON.stringify(m.content).includes(childPrompt)));
    expect(childWire).toBeDefined();
    expect(childWire?.model).toBe("beta-instance");
    expect(traffic.every(body => body.model === "beta-instance")).toBe(true);
    expect(traffic.some(body => body.messages?.some(m => m.role === "tool" && m.tool_call_id === "switch-task" && JSON.stringify(m.content).includes(childAnswer)))).toBe(true);
    const categories = JSON.parse(await readFile(join(state, "home", ".omo", "omo.json"), "utf8")) as { categories: Record<string, { models: string[] }> };
    expect(categories.categories["quick"]?.models).toEqual(["omo-mini-local/beta-instance"]);
  } finally {
    for (const cancel of pending) cancel(Error("Native switched-child fixture stopped"));
    if (processChild.exitCode === null && processChild.signalCode === null) {
      const exit = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { processChild.kill(); reject(Error("Native child RPC cleanup timeout")); }, 10000);
        processChild.once("exit", () => { clearTimeout(timer); accept(); });
      });
      processChild.stdin!.end(); processChild.kill(); await exit;
    }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
