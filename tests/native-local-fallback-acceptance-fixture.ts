import { createAgentSession, DefaultResourceLoader } from "@code-yeongyu/senpi";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, prepareProfile } from "../src/profile.ts";

type Scenario = "revert" | "stale-revert" | "stale-candidate" | "default-off" | "unloaded-switch" | "later-manual-switch" | "short-context";
const scenario = process.argv[2] as Scenario;
if (!["revert", "stale-revert", "stale-candidate", "default-off", "unloaded-switch", "later-manual-switch", "short-context"].includes(scenario)) throw Error("Invalid fixture case");

const root = await mkdtemp(join(tmpdir(), "mini-native-fallback-admission-"));
console.error(`Native fallback fixture scratch: ${root}`);
const state = join(root, "state");
let primaryVisible = true, candidateVisible = true, primaryFails = true, clock = 1000;
let alphaLoaded = scenario !== "unloaded-switch", betaLoaded = false;
const traffic: string[] = [], loads: string[] = [], events: { type: string; from?: string; to?: string }[] = [];
const nativeModel = (key: string, instances: { id: string; context: number }[]) => ({ key, type: "llm",
  capabilities: { trained_for_tool_use: true, vision: false }, max_context_length: 131072,
  loaded_instances: instances.map(item => ({ id: item.id, config: { context_length: item.context } })) });
const sse = (text: string) => new Response(`data: ${JSON.stringify({ id: "fake-local", object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fake-local", object: "chat.completion.chunk",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/v1/models") return Response.json({ models: [
    ...(primaryVisible ? [nativeModel("alpha", alphaLoaded ? [{ id: "alpha-instance", context: 65536 }] : [])] : []),
    ...(candidateVisible ? [nativeModel("beta", betaLoaded ? [{ id: "beta-instance", context: scenario === "short-context" ? 2048 : 65536 }] : [])] : []),
    ...(scenario === "later-manual-switch" ? [nativeModel("gamma", [{ id: "gamma-instance", context: 65536 }])] : []),
  ] });
  if (path === "/api/v1/models/load") {
    const body = await request.json() as { model: string };
    loads.push(body.model);
    if (body.model === "alpha") {
      alphaLoaded = true;
      return Response.json({ instance_id: "alpha-instance" });
    }
    if (body.model !== "beta") return new Response("unknown local model", { status: 404 });
    betaLoaded = true;
    return Response.json({ instance_id: "beta-instance" });
  }
  if (path === "/v1/chat/completions") {
    const body = await request.json() as { model: string };
    traffic.push(body.model);
    if ((body.model === "alpha-instance" || body.model === "gamma-instance") && primaryFails) {
      if (scenario === "stale-candidate") candidateVisible = false;
      return new Response("HTTP 503 primary unavailable", { status: 503 });
    }
    if (body.model !== "beta-instance" && body.model !== "alpha-instance" && body.model !== "gamma-instance")
      return new Response("unadmitted ID", { status: 403 });
    return sse("LOCAL-OK");
  }
  return new Response("not found", { status: 404 });
} });
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let primaryError: unknown;
try {
  const args = ["rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`,
    ...(scenario === "default-off" ? [] : ["--native-local-fallback", "beta"])];
  const profile = await prepareProfile(parseArgs(args));
  // This file is executed in a dedicated child process, never a concurrent Bun test worker.
  for (const [name, value] of Object.entries(profile.env)) if (value !== undefined) process.env[name] = value;
  const settingsPath = join(profile.paths.agent, "settings.json");
  const initialSettings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  // Native's SDK reads its own persisted model selection; unlike the CLI it was
  // invoked here without --model. Select the inspected instance, not a catalog-only
  // downloaded key with contextWindow 1. Retain Mini's 4K compaction settings.
  await writeFile(settingsPath, JSON.stringify({ ...initialSettings,
    ...(profile.model.state === "loaded" ? { defaultProvider: "omo-mini-local", defaultModel: profile.model.id } : {}),
    retry: { enabled: true, maxRetries: 0,
    provider: { maxRetries: 0 }, fallbackRevertPolicy: "cooldown-expiry" } }));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: profile.paths.agent,
    additionalExtensionPaths: [resolve(import.meta.dir, "../src/extension.ts")] });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir: profile.paths.agent, resourceLoader: loader,
    noTools: "all", autoTitleSessions: false, fallbackNow: () => clock }));
  session.subscribe(event => {
    if (event.type === "retry_fallback_applied" || event.type === "retry_fallback_reverted")
      events.push({ type: event.type, from: event.from, to: event.to });
  });
  if (scenario === "unloaded-switch") {
    if (session.model?.id !== "unknown" || session.model?.contextWindow !== 0)
      throw Error("Downloaded alpha key must retain Native no-model sentinel before selection");
    const chosen = session.modelRegistry.find("omo-mini-local", "alpha");
    if (!chosen) throw Error("Native /model candidate alpha not in the isolated registry");
    await session.setModel(chosen);
    if (session.state.model?.id !== "alpha-instance") throw Error("Manual alpha did not bind its accepted instance");
  } else if (scenario === "later-manual-switch") {
    const chosen = session.modelRegistry.find("omo-mini-local", "gamma-instance");
    if (!chosen) throw Error("Downloaded gamma instance not available");
    await session.setModel(chosen);
  } else {
    if (!session.model) throw Error("Expected loaded local primary");
    await session.setModel(session.model); // Exercise Native manual selection; fallback must preserve this default.
  }
  const homePath = join(profile.paths.home, ".omo", "omo.json");
  const catalogPath = join(profile.paths.agent, "models.json");
  // Snapshot immediately after awaited /model-equivalent completion, before
  // ANY inference. A before_provider_request repair cannot satisfy this.
  const committed = { model: session.model?.id, context: session.model?.contextWindow,
    identity: process.env["OMO_MINI_MODEL"],
    fallback: process.env["OMO_MINI_LOCAL_FALLBACK"] ? JSON.parse(process.env["OMO_MINI_LOCAL_FALLBACK"]!) as { primary: string; entries: string[] } : undefined,
    home: await readFile(homePath, "utf8"), catalog: await readFile(catalogPath, "utf8"),
    settings: await readFile(settingsPath, "utf8"), traffic: [...traffic] };
  const settingsBefore = committed.settings;
  const initialHome = await readFile(homePath, "utf8"), initialCatalog = await readFile(catalogPath, "utf8");
  try { await session.prompt("Reply LOCAL-OK without tools."); } catch (error) {
    if (scenario !== "stale-candidate" && scenario !== "default-off" && scenario !== "short-context") throw error;
  }
  const first = { active: session.model?.id, identity: process.env["OMO_MINI_MODEL"], home: await readFile(homePath, "utf8"),
    catalog: await readFile(catalogPath, "utf8"), settings: await readFile(settingsPath, "utf8"),
    traffic: [...traffic], loads: [...loads], events: [...events] };
  if (scenario === "revert" || scenario === "stale-revert") {
    // Native's injected selector-cooldown clock moves only after the first turn has settled.
    // Subscribe above before triggering the next turn; no wall-clock wait/poll.
    clock += 60000;
    if (scenario === "stale-revert") primaryVisible = false;
    else primaryFails = false;
    await session.prompt("Reply LOCAL-OK again without tools.");
  }
  const home = await readFile(homePath, "utf8"), catalog = await readFile(catalogPath, "utf8");
  console.log(JSON.stringify({ scenario, committed, first, initialHome, initialCatalog,
    final: { active: session.model?.id, identity: process.env["OMO_MINI_MODEL"], home, catalog, settings: await readFile(settingsPath, "utf8"),
      traffic, loads, events }, settingsBefore }));
} catch (error) { primaryError = error; throw error; }
finally {
  const cleanup: unknown[] = [];
  try { session?.dispose(); } catch (error) { cleanup.push(error); }
  try { server.stop(true); } catch (error) { cleanup.push(error); }
  try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
  if (cleanup.length) throw new AggregateError(primaryError === undefined ? cleanup : [primaryError, ...cleanup],
    `Native fallback fixture cleanup failed; scratch at ${root}`);
}
