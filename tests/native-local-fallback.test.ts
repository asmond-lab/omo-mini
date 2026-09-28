import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type: string; id?: string; success?: boolean; data?: Record<string, unknown>; from?: string; to?: string; willRetry?: boolean; aborted?: boolean };
const model = (key: string, instances: { id: string; context: number }[]) => ({ key, type: "llm", max_context_length: 131072,
  capabilities: { trained_for_tool_use: true, vision: false }, loaded_instances: instances.map(i => ({ id: i.id, config: { context_length: i.context } })) });

// Close confirms that stdout/stderr have drained. Never delete a workspace while
// its owner may still be running. Preserve both the test error and cleanup error.
async function closeOwnedRpc(child: ChildProcess, closed: Promise<void>, server: { stop(closeActiveConnections?: boolean): void },
  root: string, priorError?: unknown): Promise<void> {
  const failures: unknown[] = [];
  let confirmed = false;
  try {
    child.stdin?.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise<never>((_accept, reject) => {
        timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error(`Native RPC close unconfirmed; scratch retained at ${root}`)); }, 10000);
      })]);
      confirmed = true;
    } finally { if (timer) clearTimeout(timer); }
  } catch (error) { failures.push(error); }
  try { server.stop(true); } catch (error) { failures.push(error); }
  if (confirmed) {
    try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(priorError === undefined ? failures : [priorError, ...failures],
    `Native RPC cleanup failed${confirmed ? "" : `; scratch retained at ${root}`}`);
}

// Actual Mini launcher -> actual pinned Native RPC/retry controller -> fake loopback LM Studio.
// Events are subscribed before each action; no sleep/polling or model/external request.
test("explicit Native local fallback loads effective instance, keeps manual default, denies stale and cancelled targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-native-local-fallback-"));
  const state = join(root, "state"), agent = join(state, "agent");
  await mkdir(agent, { recursive: true });
  // Existing settings survive Mini's wx setup. Native uses this actual retry configuration.
  await writeFile(join(agent, "settings.json"), JSON.stringify({
    compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 4096 },
    retry: { enabled: true, maxRetries: 0, provider: { maxRetries: 0 }, fallbackRevertPolicy: "never" },
  }));
  const inference: string[] = [], loads: string[] = [];
  let secondary: { id: string; context: number } | undefined;
  let loadEntered = Promise.withResolvers<void>(), releaseLoad = Promise.withResolvers<void>();
  let holdLoad = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [
      model("alpha", [{ id: "alpha-instance", context: 65536 }]),
      model("beta", secondary ? [secondary] : []),
    ] });
    if (path === "/api/v1/models/load") {
      const body = await request.json() as { model: string };
      loads.push(body.model);
      if (holdLoad) { loadEntered.resolve(); await releaseLoad.promise; }
      secondary = { id: "beta-instance", context: 65536 };
      return Response.json({ instance_id: secondary.id });
    }
    if (path === "/v1/chat/completions") {
      const body = await request.json() as { model: string };
      inference.push(body.model);
      if (body.model === "alpha-instance") return new Response("unavailable", { status: 503 });
      if (body.model !== "beta-instance") return new Response("not admitted", { status: 403 });
      return new Response(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "LOCAL-SECONDARY-OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  } });
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state,
    "--base-url", `http://127.0.0.1:${server.port}/v1`, "--native-local-fallback", "beta"],
  { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const close = Promise.withResolvers<void>();
  child.once("close", () => close.resolve()); child.once("error", error => close.reject(error));
  void close.promise.catch(() => {});
  let buffer = "", errors = "", counter = 0;
  const listeners = new Set<(frame: Frame) => void>();
  const pending = new Set<(error: Error) => void>();
  child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      for (const onFrame of listeners) onFrame(frame);
    }
  });
  const wait = (predicate: (frame: Frame) => boolean) => {
    const result = new Promise<Frame>((accept, reject) => {
      const clear = () => { clearTimeout(timer); listeners.delete(onFrame); child.off("exit", onExit); pending.delete(cancel); };
      const cancel = (reason: Error) => { clear(); reject(reason); };
      const onFrame = (frame: Frame) => { if (predicate(frame)) { clear(); accept(frame); } };
      const onExit = () => cancel(Error(`Native exited: ${errors.slice(-1000)}`));
      const timer = setTimeout(() => cancel(Error(`Native deadline: ${errors.slice(-1000)} ${JSON.stringify(inference)}`)), 45000);
      listeners.add(onFrame); child.once("exit", onExit); pending.add(cancel);
    });
    void result.catch(() => {});
    return result;
  };
  const send = (type: string, fields: Record<string, unknown> = {}) => {
    const id = String(++counter), response = wait(frame => frame.type === "response" && frame.id === id);
    child.stdin!.write(JSON.stringify({ id, type, ...fields }) + "\n");
    return response;
  };
  let testError: unknown;
  try {
    // Manual selection establishes the persisted default; automatic fallback must not replace it.
    expect((await send("set_model", { provider: "omo-mini-local", modelId: "alpha-instance" })).success).toBe(true);
    const defaultBefore = JSON.parse(await readFile(join(agent, "settings.json"), "utf8")) as { defaultModel: string; defaultProvider: string };
    expect(defaultBefore.defaultModel).toBe("alpha-instance");
    holdLoad = true;
    const fallback = wait(frame => frame.type === "retry_fallback_applied");
    const ended = wait(frame => frame.type === "agent_end" && !frame.willRetry && !frame.aborted);
    expect((await send("prompt", { message: "Respond LOCAL-SECONDARY-OK" })).success).toBe(true);
    await Promise.race([loadEntered.promise, new Promise<never>((_done, reject) => {
      const timer = setTimeout(() => reject(Error("Native never requested the fallback load")), 30000);
      void loadEntered.promise.then(() => clearTimeout(timer));
    })]);
    expect(inference).toEqual(["alpha-instance"]); // no unadmitted secondary HTTP while load is held
    releaseLoad.resolve();
    const transition = await fallback;
    expect(transition.from).toBe("omo-mini-local/alpha-instance");
    expect(transition.to).toBe("omo-mini-local/beta-instance");
    await ended;
    expect(inference).toEqual(["alpha-instance", "beta-instance"]);
    expect(loads).toEqual(["beta"]);
    expect(((await send("get_state")).data?.["model"] as { id: string; contextWindow: number }).id).toBe("beta-instance");
    const config = JSON.parse(await readFile(join(state, "home", ".omo", "omo.json"), "utf8")) as { categories: Record<string, { models: string[] }> };
    expect(config.categories["quick"]?.models).toEqual(["omo-mini-local/beta-instance"]);
    const catalog = JSON.parse(await readFile(join(agent, "models.json"), "utf8")) as { providers: Record<string, { models: { id: string; contextWindow: number }[] }> };
    expect(catalog.providers["omo-mini-local"]?.models.find(item => item.id === "beta-instance")?.contextWindow).toBe(65536);
    const defaultAfter = JSON.parse(await readFile(join(agent, "settings.json"), "utf8")) as { defaultModel: string; defaultProvider: string };
    expect(defaultAfter).toEqual(defaultBefore);
    // A remote/foreign or stale ID cannot enter the automatic chain simply by existing in a registry.
    expect(inference.every(id => id === "alpha-instance" || id === "beta-instance")).toBe(true);
    // Cancel a second automatic load before it commits; prior identity and files remain unchanged.
    expect((await send("set_model", { provider: "omo-mini-local", modelId: "alpha-instance" })).success).toBe(true);
    secondary = undefined; loadEntered = Promise.withResolvers<void>(); releaseLoad = Promise.withResolvers<void>();
    const priorHome = await readFile(join(state, "home", ".omo", "omo.json"), "utf8");
    const priorCatalog = await readFile(join(agent, "models.json"), "utf8");
    const priorSettings = await readFile(join(agent, "settings.json"), "utf8");
    const cancelledEnd = wait(frame => frame.type === "session_abort"); // Abort during Native's retry gap, after agent_end(willRetry).
    const cancelledPrompt = send("prompt", { message: "This fallback load must be cancelled" });
    await Promise.race([loadEntered.promise, new Promise<never>((_done, reject) => {
      const timer = setTimeout(() => reject(Error("Native never entered cancellable fallback load")), 30000);
      void loadEntered.promise.then(() => clearTimeout(timer));
    })]);
    expect((await send("abort")).success).toBe(true);
    releaseLoad.resolve();
    await cancelledPrompt; await cancelledEnd;
    expect(((await send("get_state")).data?.["model"] as { id: string }).id).toBe("alpha-instance");
    expect(await readFile(join(state, "home", ".omo", "omo.json"), "utf8")).toBe(priorHome);
    expect(await readFile(join(agent, "models.json"), "utf8")).toBe(priorCatalog);
    expect(await readFile(join(agent, "settings.json"), "utf8")).toBe(priorSettings);
    expect(inference.at(-1)).toBe("alpha-instance");
  } catch (error) { testError = error; throw error; } finally {
    releaseLoad.resolve();
    for (const reject of pending) reject(Error("Native local fallback fixture stopped"));
    await closeOwnedRpc(child, close.promise, server, root, testError);
  }
}, 120000);


test("explicit local fallback rejects cloud, foreign and stale IDs before Native startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-invalid-fallback-"));
  let inference = 0;
  let allClosed = true, testError: unknown;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/v1/models")
      return Response.json({ models: [model("alpha", [{ id: "alpha-instance", context: 65536 }])] });
    inference++;
    return new Response("unexpected request", { status: 500 });
  } });
  try {
    for (const invalid of ["openai/gpt-6-sol", "foreign-instance", "stale-local-key"]) {
      const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root,
        "--state-dir", join(root, invalid.replaceAll("/", "-")), "--base-url", `http://127.0.0.1:${server.port}/v1`,
        "--native-local-fallback", invalid], { cwd: resolve(import.meta.dir, ".."), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let errors = "";
      child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
      child.stdout!.on("data", () => {}); // Drain both pipes before inspecting stderr.
      const code = await new Promise<number>((accept, reject) => {
        const timer = setTimeout(() => {
          allClosed = false; child.kill("SIGKILL");
          reject(Error(`Native invalid-option close unconfirmed; scratch retained at ${root}: ${errors}`));
        }, 15000);
        child.once("error", error => { allClosed = false; clearTimeout(timer); reject(error); });
        child.once("close", value => { clearTimeout(timer); accept(value ?? 1); });
      });
      expect(code).toBe(1);
      expect(errors).toContain(`Fallback ${invalid} is not an eligible downloaded local model`);
      expect(inference).toBe(0);
    }
  } catch (error) { testError = error; throw error; } finally {
    const failures: unknown[] = [];
    try { server.stop(true); } catch (error) { failures.push(error); }
    if (allClosed) { try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(testError === undefined ? failures : [testError, ...failures],
      `Invalid-ID fixture cleanup failed${allClosed ? "" : `; scratch retained at ${root}`}`);
  }
});


test("opt-in never infers at unloaded startup until real Native /model admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-unloaded-fallback-"));
  const state = join(root, "state");
  let loaded = false, inference = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [model("alpha", loaded ? [{ id: "alpha-instance", context: 65536 }] : []), model("beta", [])] });
    if (path === "/api/v1/models/load") { loaded = true; return Response.json({ instance_id: "alpha-instance" }); }
    if (path === "/v1/chat/completions") { inference++; return new Response("unexpected inference", { status: 500 }); }
    return new Response("not found", { status: 404 });
  } });
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state,
    "--base-url", `http://127.0.0.1:${server.port}/v1`, "--native-local-fallback", "beta"],
    { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const close = Promise.withResolvers<void>();
  child.once("close", () => close.resolve()); child.once("error", error => close.reject(error));
  void close.promise.catch(() => {});
  let buffer = "", errors = "", index = 0;
  const listeners = new Set<(frame: Frame) => void>();
  child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.startsWith("{")) for (const listener of listeners) listener(JSON.parse(line) as Frame);
    }
  });
  const send = (type: string, fields: Record<string, unknown> = {}) => {
    const id = String(++index);
    const reply = new Promise<Frame>((accept, reject) => {
      const clear = () => { clearTimeout(timer); listeners.delete(onFrame); child.off("exit", onExit); };
      const onFrame = (frame: Frame) => { if (frame.type === "response" && frame.id === id) { clear(); accept(frame); } };
      const onExit = () => { clear(); reject(Error(`Native exited: ${errors}`)); };
      const timer = setTimeout(() => { clear(); reject(Error(`Native RPC deadline: ${errors}`)); }, 45000);
      listeners.add(onFrame); child.once("exit", onExit);
    });
    child.stdin!.write(JSON.stringify({ id, type, ...fields }) + "\n");
    return reply;
  };
  let testError: unknown;
  try {
    expect((await send("get_state")).data?.["model"]).toMatchObject({ id: "unknown", contextWindow: 0 });
    const rejected = await send("prompt", { message: "Do not infer before /model" });
    expect(rejected.success).toBe(false);
    expect(JSON.stringify(rejected)).toContain("/model");
    expect(inference).toBe(0);
    expect((await send("set_model", { provider: "omo-mini-local", modelId: "alpha" })).success).toBe(true);
    expect(((await send("get_state")).data?.["model"] as { id: string }).id).toBe("alpha-instance");
    expect(inference).toBe(0);
  } catch (error) { testError = error; throw error; } finally {
    await closeOwnedRpc(child, close.promise, server, root, testError);
  }
});
