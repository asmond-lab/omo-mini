import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type: string; id?: string; success?: boolean; data?: Record<string, unknown> };

test("failed load and too-small effective context leave Native model, registry and child config unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-rejected-switch-"));
  const state = join(root, "state");
  let failure: "http" | "wait" | "short-context" = "http";
  const loadStarted = Promise.withResolvers<void>(), loadRelease = Promise.withResolvers<void>(), remoteSettled = Promise.withResolvers<void>();
  let betaLoaded = false;
  const inference: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [
      { key: "alpha", type: "llm", max_context_length: 131072, capabilities: { trained_for_tool_use: true },
        loaded_instances: [{ id: "alpha-instance", config: { context_length: 65536 } }] },
      { key: "beta", type: "llm", max_context_length: 131072, capabilities: { trained_for_tool_use: true },
        loaded_instances: betaLoaded ? [{ id: "beta-instance", config: { context_length: 4096 } }] : [] },
    ] });
    if (path === "/api/v1/models/load") {
      expect((await request.json() as { model: string }).model).toBe("beta");
      if (failure === "http") return new Response("model unavailable", { status: 503 });
      if (failure === "wait") { loadStarted.resolve(); await loadRelease.promise; }
      betaLoaded = true;
      if (failure === "wait") remoteSettled.resolve();
      return Response.json({ instance_id: "beta-instance" });
    }
    if (path === "/v1/chat/completions") {
      inference.push((await request.json() as { model: string }).model);
      return new Response(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ALPHA-OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  } });
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`],
    { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "", stderr = "", nextId = 0;
  const listeners = new Set<(frame: Frame) => void>();
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      for (const listener of listeners) listener(frame);
    }
  });
  const wait = (match: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
    const onFrame = (frame: Frame) => { if (match(frame)) { clearTimeout(timer); child.off("exit", onExit); listeners.delete(onFrame); accept(frame); } };
    const onExit = () => { clearTimeout(timer); listeners.delete(onFrame); reject(Error(`Native RPC exited: ${stderr.slice(-1100)}`)); };
    const timer = setTimeout(() => { child.off("exit", onExit); listeners.delete(onFrame); reject(Error(`Native RPC timeout: ${stderr.slice(-1100)}`)); }, 45000);
    listeners.add(onFrame); child.once("exit", onExit);
  });
  const send = (type: string, fields: Record<string, unknown> = {}) => {
    const id = String(++nextId), answer = wait(frame => frame.type === "response" && frame.id === id);
    child.stdin!.write(JSON.stringify({ id, type, ...fields }) + "\n");
    return answer;
  };
  try {
    expect(((await send("get_state")).data?.["model"] as { id: string }).id).toBe("alpha-instance");
    const beforeModels = (await send("get_available_models")).data?.["models"];
    const beforeHome = await readFile(join(state, "home", ".omo", "omo.json"), "utf8");
    const beforeCatalog = await readFile(join(state, "agent", "models.json"), "utf8");
    for (const mode of ["http", "wait", "short-context"] as const) {
      failure = mode;
      const resultPromise = send("set_model", { provider: "omo-mini-local", modelId: "beta" });
      if (mode === "wait") {
        await Promise.race([loadStarted.promise, new Promise<never>((_accept, reject) => {
          const timeout = setTimeout(() => reject(Error("Local load was not entered")), 15000);
          void loadStarted.promise.then(() => clearTimeout(timeout));
        })]);
        expect((await send("abort")).success).toBe(true);
      }
      const result = await resultPromise;
      if (mode === "wait") { loadRelease.resolve(); await remoteSettled.promise; }
      expect(result.success, `${mode}: ${JSON.stringify(result)} ${stderr.slice(-1100)}`).toBe(false);
      expect(((await send("get_state")).data?.["model"] as { id: string }).id).toBe("alpha-instance");
      expect((await send("get_available_models")).data?.["models"]).toEqual(beforeModels);
      expect(await readFile(join(state, "home", ".omo", "omo.json"), "utf8")).toBe(beforeHome);
      expect(await readFile(join(state, "agent", "models.json"), "utf8")).toBe(beforeCatalog);
    }
    const ended = wait(frame => frame.type === "agent_end");
    expect((await send("prompt", { message: "Respond ALPHA-OK" })).success).toBe(true);
    await ended;
    expect(inference.length).toBeGreaterThan(0);
    expect(new Set(inference)).toEqual(new Set(["alpha-instance"]));
  } finally {
    loadRelease.resolve();
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error("Native RPC cleanup timeout")); }, 10000);
        child.once("exit", () => { clearTimeout(timer); accept(); });
      });
      child.stdin!.end(); child.kill(); await exit;
    }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
