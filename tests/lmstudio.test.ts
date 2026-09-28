import { expect, test } from "bun:test";
import { listDownloadedModels, loadModel } from "../src/lmstudio.ts";
import { sdkModel } from "../src/local.ts";

const candidate = (loaded_instances: unknown[] = [], capabilities = { trained_for_tool_use: true, vision: false }) => ({
  type: "llm", key: "qwen-local", max_context_length: 131072, capabilities, loaded_instances,
});
const instance = (id = "instance-42", context_length = 8192) => ({ id, config: { context_length } });
const base = (server: ReturnType<typeof Bun.serve>) => `http://127.0.0.1:${server.port}/v1`;

test("catalog lists downloaded eligible models with actual loaded contexts, without requiring a loaded model", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return Response.json({ models: [candidate(), { ...candidate([instance("loaded", 4096), instance("other", 16384)]), key: "second" },
      { ...candidate(), key: "embedding", type: "embedding" },
      { ...candidate(), key: "no-tools", capabilities: { trained_for_tool_use: false, vision: false } }] });
  } });
  try {
    const models = await listDownloadedModels(base(server));
    expect(models.map(model => model.key)).toEqual(["qwen-local", "second"]);
    expect(models[0]?.loaded_instances).toEqual([]);
    expect(models[1]?.loaded_instances).toEqual([{ id: "loaded", context_length: 4096 }, { id: "other", context_length: 16384 }]);
    expect(models[1]?.max_context_length).toBe(131072);
    expect(requests).toEqual(["GET /api/v1/models"]);
  } finally { server.stop(true); }
});

test("load uses the returned instance ID and inspected effective context, without unloading other instances", async () => {
  const requests: string[] = [];
  let loaded = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith("/load")) {
      expect(await request.json()).toEqual({ model: "qwen-local", echo_load_config: true });
      loaded = true;
      return Response.json({ instance_id: "instance-42", load_config: { context_length: 8192 } });
    }
    return Response.json({ models: [candidate(loaded ? [instance()] : []),
      { ...candidate([instance("unrelated", 32768)]), key: "another" }] });
  } });
  try {
    const selected = await loadModel(base(server), "qwen-local");
    expect(selected).toMatchObject({ id: "instance-42", loaded_context_length: 8192, capabilities: ["tool_use"] });
    expect(sdkModel(selected, base(server)).contextWindow).toBe(8192);
    expect(requests).toEqual(["GET /api/v1/models", "POST /api/v1/models/load", "GET /api/v1/models"]);
  } finally { server.stop(true); }
});

test("reuses already loaded instance and preserves vision capability", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(request.method);
    return Response.json({ models: [candidate([instance("vlm-instance", 12288)], { trained_for_tool_use: true, vision: true })] });
  } });
  try {
    const selected = await loadModel(base(server), "qwen-local");
    expect(selected.type).toBe("vlm");
    expect(sdkModel(selected, base(server)).input).toEqual(["text", "image"]);
    expect(requests).toEqual(["GET"]);
  } finally { server.stop(true); }
});

test("empty catalog, missing key, unsupported model and malformed responses have distinct errors", async () => {
  let models: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname.endsWith("/load")) return Response.json({ invalid: true });
    return Response.json({ models });
  } });
  try {
    expect(await listDownloadedModels(base(server))).toEqual([]);
    await expect(loadModel(base(server), "qwen-local")).rejects.toMatchObject({ code: "no_downloaded_model" });
    models = [candidate()];
    await expect(loadModel(base(server), "missing")).rejects.toMatchObject({ code: "model_unavailable" });
    models = [candidate([], { trained_for_tool_use: false, vision: false })];
    await expect(loadModel(base(server), "qwen-local")).rejects.toMatchObject({ code: "unsupported_model" });
    models = [candidate()];
    await expect(loadModel(base(server), "qwen-local")).rejects.toMatchObject({ code: "load_error" });
    models = [{ key: "bad", type: "llm", loaded_instances: [{ id: "bad", config: {} }] }];
    await expect(listDownloadedModels(base(server))).rejects.toMatchObject({ code: "endpoint" });
  } finally { server.stop(true); }
});

test("load HTTP error, absent returned instance and cancellation are explicit", async () => {
  let mode: "http" | "absent" = "http";
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests++;
    if (new URL(request.url).pathname.endsWith("/load"))
      return mode === "http" ? new Response("busy", { status: 503 }) : Response.json({ instance_id: "not-listed" });
    return Response.json({ models: [candidate()] });
  } });
  try {
    await expect(loadModel(base(server), "qwen-local")).rejects.toMatchObject({ code: "load_error" });
    mode = "absent";
    await expect(loadModel(base(server), "qwen-local")).rejects.toMatchObject({ code: "load_error" });
    const controller = new AbortController();
    controller.abort();
    const before = requests;
    await expect(loadModel(base(server), "qwen-local", controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(requests).toBe(before);
  } finally { server.stop(true); }
});

test("stopped server is not an empty catalog", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({ models: [] }); } });
  const url = base(server);
  server.stop(true);
  await expect(listDownloadedModels(url)).rejects.toMatchObject({ code: "server_unreachable" });
});

test("abort after the load request arrives cancels the in-flight response without inspecting it", async () => {
  const incoming = Promise.withResolvers<void>();
  const controller = new AbortController();
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith("/load")) {
      incoming.resolve();
      return new Promise<Response>(() => {}); // Held open until client aborts and server is stopped.
    }
    return Response.json({ models: [candidate()] });
  } });
  try {
    const result = loadModel(base(server), "qwen-local", controller.signal);
    await incoming.promise; // Subscribe before triggering load; no sleep/polling.
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(requests).toEqual(["GET /api/v1/models", "POST /api/v1/models/load"]);
  } finally { server.stop(true); }
}, 3000);
