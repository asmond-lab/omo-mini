import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type: string; id?: string; success?: boolean; data?: Record<string, unknown> };

test("no-flag restart and selected-session resume retain the switched actual local instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-restart-"));
  const state = join(root, "state");
  const loaded = new Set<string>();
  const wireModels: string[] = [];
  const base = (port: number) => `http://127.0.0.1:${port}/v1`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: ["alpha", "beta"].map(key => ({
      key, type: "llm", max_context_length: 131072, capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: loaded.has(key) ? [{ id: `${key}-instance`, config: { context_length: 65536 } }] : [],
    })) });
    if (path === "/api/v1/models/load") {
      const body = await request.json() as { model: string };
      if (body.model !== "alpha" && body.model !== "beta") return new Response("unknown", { status: 404 });
      loaded.add(body.model);
      return Response.json({ instance_id: `${body.model}-instance` });
    }
    if (path === "/v1/chat/completions") {
      const body = await request.json() as { model: string };
      wireModels.push(body.model);
      return new Response(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "LOCAL-OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  } });
  const sessions: ReturnType<typeof spawn>[] = [];
  const start = () => {
    const proc = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", base(server.port!)],
      { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    sessions.push(proc);
    const listeners = new Set<(frame: Frame) => void>();
    let buffer = "", stderr = "", id = 0;
    proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8"); let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.startsWith("{")) continue;
        const frame = JSON.parse(line) as Frame;
        for (const listener of listeners) listener(frame);
      }
    });
    const wait = (acceptFrame: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
      const done = (frame: Frame) => { clearTimeout(timer); proc.off("exit", onExit); listeners.delete(onFrame); accept(frame); };
      const onFrame = (frame: Frame) => { if (acceptFrame(frame)) done(frame); };
      const onExit = () => { clearTimeout(timer); listeners.delete(onFrame); reject(Error(`Native RPC exited: ${stderr.slice(-1000)}`)); };
      const timer = setTimeout(() => { proc.off("exit", onExit); listeners.delete(onFrame); reject(Error(`Native RPC timeout: ${stderr.slice(-1000)}`)); }, 45000);
      listeners.add(onFrame);
      proc.once("exit", onExit);
    });
    const send = (type: string, rest: Record<string, unknown> = {}) => {
      const next = String(++id), response = wait(frame => frame.type === "response" && frame.id === next);
      proc.stdin!.write(JSON.stringify({ id: next, type, ...rest }) + "\n");
      return response;
    };
    const close = async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { proc.kill(); reject(Error(`Native RPC failed to exit: ${stderr.slice(-1000)}`)); }, 10000);
        proc.once("exit", () => { clearTimeout(timer); accept(); });
      });
      proc.stdin!.end(); await exited;
    };
    return { send, wait, close };
  };
  try {
    let rpc = start();
    // Native's agent state projects its genuine no-selected-model sentinel to RPC.
    expect((await rpc.send("get_state")).data?.["model"]).toMatchObject({ id: "unknown", provider: "unknown", contextWindow: 0 });
    const pending = await rpc.send("prompt", { message: "Answer before selecting a model." });
    expect(pending.success).toBe(false);
    expect(JSON.stringify(pending)).toContain("/model");
    expect(wireModels).toHaveLength(0);
    for (const [key, id] of [["alpha", "alpha-instance"], ["beta", "beta-instance"]] as const) {
      const result = await rpc.send("set_model", { provider: "omo-mini-local", modelId: key });
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(((await rpc.send("get_state")).data?.["model"] as { id: string }).id).toBe(id);
    }
    const firstEnd = rpc.wait(frame => frame.type === "agent_end");
    expect((await rpc.send("prompt", { message: "Answer LOCAL-OK." })).success).toBe(true);
    await firstEnd;
    const firstTurnRequests = wireModels.length;
    expect(firstTurnRequests).toBeGreaterThan(0);
    const saved = (await rpc.send("get_state")).data?.["sessionFile"];
    expect(typeof saved).toBe("string");
    await rpc.close();
    const settings = JSON.parse(await readFile(join(state, "agent", "settings.json"), "utf8")) as { defaultModel?: string; defaultProvider?: string };
    expect(settings).toMatchObject({ defaultModel: "beta-instance", defaultProvider: "omo-mini-local" });
    rpc = start(); // No --model: both instances are loaded, alpha appears first in the catalog.
    expect(((await rpc.send("get_state")).data?.["model"] as { id: string }).id).toBe("beta-instance");
    expect((await rpc.send("switch_session", { sessionPath: saved })).success).toBe(true);
    const secondEnd = rpc.wait(frame => frame.type === "agent_end");
    expect((await rpc.send("prompt", { message: "Continue and answer LOCAL-OK." })).success).toBe(true);
    await secondEnd;
    expect(wireModels.length).toBeGreaterThan(firstTurnRequests);
    expect(new Set(wireModels)).toEqual(new Set(["beta-instance"]));
    expect((JSON.parse(await readFile(join(state, "agent", "models.json"), "utf8")) as { providers: Record<string, { models: { id: string }[] }> })
      .providers["omo-mini-local"]?.models.some(model => model.id === "beta-instance")).toBe(true);
    await rpc.close();
  } finally {
    await Promise.all(sessions.filter(proc => proc.exitCode === null && proc.signalCode === null).map(proc => new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(Error("Native RPC cleanup timeout")); }, 10000);
      proc.once("exit", () => { clearTimeout(timer); accept(); });
      proc.stdin?.end(); proc.kill();
    })));
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 150000);
