import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

type Snapshot = { active?: string; identity?: string; home: string; catalog: string; settings: string;
  traffic: string[]; loads: string[]; events: { type: string; from?: string; to?: string }[] };
type Receipt = { first: Snapshot; initialHome: string; initialCatalog: string; final: Snapshot; settingsBefore: string };
type Committed = { model?: string; context?: number; identity?: string;
  fallback?: { primary: string; entries: string[] }; home: string; catalog: string; settings: string; traffic: string[] };

// Each fixture is a real Native SDK child. Its inner 45s admission deadline and
// bounded 10s shutdown must settle before Bun's per-test deadline, even when
// other test files contend for startup resources.
const run = async (scenario: string): Promise<Receipt & { committed: Committed }> => {
  const names = ["PATH", "Path", "SystemRoot", "windir", "ComSpec", "TEMP", "TMP", "BUN_INSTALL"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  env["TEMP"] ??= tmpdir(); env["TMP"] ??= tmpdir();
  const child = spawn(process.execPath, [resolve(import.meta.dir, "native-local-fallback-acceptance-fixture.ts"), scenario],
    { cwd: resolve(import.meta.dir, ".."), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "", err = "", spawnError: Error | undefined, expired = false;
  child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  // Register the process's drained-stdio signal before scheduling admission or termination.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(accept => {
    child.once("close", (code, signal) => accept({ code, signal }));
  });
  child.once("error", error => { spawnError = error; child.kill(); });
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let closeError: Error | undefined;
  const deadline = new Promise<never>((_accept, reject) => {
    admissionTimer = setTimeout(() => { expired = true; child.kill(); }, 45000);
    terminationTimer = setTimeout(() => { if (expired) child.kill("SIGKILL"); }, 50000);
    closeTimer = setTimeout(() => {
      closeError = Error(`Native ${scenario} close unconfirmed; owned fixture scratch retained: ${err}`);
      reject(closeError);
    }, 55000);
  });
  try {
    const { code, signal } = await Promise.race([closed, deadline]);
    if (spawnError) throw Error(`Native ${scenario} spawn failed: ${spawnError.message}`, { cause: spawnError });
    if (expired) throw Error(`Native ${scenario} admission deadline: ${err}`);
    if (code !== 0) throw Error(`Native ${scenario} exited ${signal ?? code}: ${err}`);
    try { return JSON.parse(out.trim().split(/\r?\n/).at(-1)!) as Receipt & { committed: Committed }; }
    catch (error) { throw Error(`Native ${scenario} invalid receipt: ${out} ${String(error)}`, { cause: error }); }
  } catch (error) {
    if (error === closeError && (spawnError || expired))
      throw new AggregateError([spawnError ?? Error(`Native ${scenario} admission deadline: ${err}`), error],
        `Native ${scenario} failed and its owned child did not close`);
    throw error;
  } finally {
    if (admissionTimer) clearTimeout(admissionTimer);
    if (terminationTimer) clearTimeout(terminationTimer);
    if (closeTimer) clearTimeout(closeTimer);
  }
};

test("Native fallback reverts through actual local admission after clock-controlled cooldown", async () => {
  const r = await run("revert");
  expect(r.first.traffic).toEqual(["alpha-instance", "beta-instance"]);
  expect(r.first.loads).toEqual(["beta"]);
  expect(r.first.active).toBe("beta-instance");
  expect(r.first.events).toContainEqual(expect.objectContaining({ type: "retry_fallback_applied",
    from: "omo-mini-local/alpha-instance", to: "omo-mini-local/beta-instance" }));
  expect(JSON.parse(r.first.catalog).providers["omo-mini-local"].models.find((m: { id: string }) => m.id === "beta-instance").contextWindow).toBe(65536);
  expect(r.final.traffic).toEqual(["alpha-instance", "beta-instance", "alpha-instance"]);
  expect(r.final.active).toBe("alpha-instance");
  expect(r.final.events).toContainEqual(expect.objectContaining({ type: "retry_fallback_reverted",
    from: "omo-mini-local/beta-instance", to: "omo-mini-local/alpha-instance" }));
  expect(JSON.parse(r.final.home).categories.quick.models).toEqual(["omo-mini-local/alpha-instance"]);
  expect(r.first.settings).toBe(r.settingsBefore);
  expect(r.final.settings).toBe(r.settingsBefore); // persistDefault:false is real, not an inferred flag.
}, 70000);

test("catalog disappearance denies stale original instance during automatic revert", async () => {
  const r = await run("stale-revert");
  expect(r.first.active).toBe("beta-instance");
  expect(r.final.active).toBe("beta-instance");
  expect(r.final.traffic).toEqual(["alpha-instance", "beta-instance", "beta-instance"]);
  expect(r.final.events.filter(e => e.type === "retry_fallback_reverted")).toEqual([]);
  expect(r.final.home).toBe(r.first.home);
  expect(r.final.catalog).toBe(r.first.catalog);
  expect(r.final.settings).toBe(r.settingsBefore);
}, 70000);

test("post-startup catalog disappearance denies the stale candidate before secondary HTTP", async () => {
  const r = await run("stale-candidate");
  expect(r.first.active).toBe("alpha-instance");
  expect(r.first.traffic).toEqual(["alpha-instance"]);
  expect(r.first.loads).toEqual([]);
  expect(r.first.events.filter(e => e.type === "retry_fallback_applied")).toEqual([]);
  expect(r.first.home).toBe(r.initialHome);
  expect(r.first.catalog).toBe(r.initialCatalog);
  expect(r.first.settings).toBe(r.settingsBefore);
}, 70000);

test("too-small loaded beta is refused before secondary inference without changing the accepted primary", async () => {
  const r = await run("short-context");
  expect(r.committed.model).toBe("alpha-instance");
  expect(r.committed.context).toBe(65536);
  expect(r.first.loads).toEqual(["beta"]); // Real load returned beta-instance at effective context 2048.
  expect(r.first.traffic).toEqual(["alpha-instance"]);
  expect(r.first.active).toBe("alpha-instance");
  expect(r.first.identity).toBe("alpha-instance");
  expect(r.first.events.filter(event => event.type === "retry_fallback_applied")).toEqual([]);
  expect(r.first.home).toBe(r.initialHome);
  expect(r.first.catalog).toBe(r.initialCatalog);
  expect(r.first.settings).toBe(r.settingsBefore);
  expect(r.final.active).toBe("alpha-instance");
  expect(r.final.identity).toBe("alpha-instance");
  expect(r.final.traffic).toEqual(["alpha-instance"]);
  expect(r.final.settings).toBe(r.settingsBefore);
}, 70000);

test("default-off primary failure never calls a local or cloud fallback", async () => {
  const r = await run("default-off");
  expect(r.first.traffic).toEqual(["alpha-instance"]);
  expect(r.first.loads).toEqual([]);
  expect(r.first.events).toEqual([]);
  expect(r.first.active).toBe("alpha-instance");
  expect(r.first.home).toBe(r.initialHome);
  expect(r.first.catalog).toBe(r.initialCatalog);
  expect(r.first.settings).toBe(r.settingsBefore);
}, 70000);

test("unloaded alpha key becomes accepted alpha-instance primary before Native beta fallback", async () => {
  const r = await run("unloaded-switch");
  expect(r.committed.traffic).toEqual([]);
  expect(r.committed.model).toBe("alpha-instance");
  expect(r.committed.context).toBe(65536);
  expect(r.committed.identity).toBe("alpha-instance");
  expect(r.committed.fallback).toMatchObject({ primary: "omo-mini-local/alpha-instance", entries: ["omo-mini-local/beta"] });
  expect(JSON.parse(r.committed.home).categories.quick.models).toEqual(["omo-mini-local/alpha-instance"]);
  expect(JSON.parse(r.committed.settings).defaultModel).toBe("alpha-instance");
  expect(r.first.traffic).toEqual(["alpha-instance", "beta-instance"]);
  expect(r.first.loads).toEqual(["alpha", "beta"]);
  expect(r.first.active).toBe("beta-instance");
  expect(r.first.events).toContainEqual(expect.objectContaining({ type: "retry_fallback_applied",
    from: "omo-mini-local/alpha-instance", to: "omo-mini-local/beta-instance" }));
  expect(JSON.parse(r.settingsBefore).defaultModel).toBe("alpha-instance");
  expect(r.first.settings).toBe(r.settingsBefore);
}, 70000);

test("a later manual gamma selection binds its own effective primary before fallback", async () => {
  const r = await run("later-manual-switch");
  expect(r.committed.traffic).toEqual([]);
  expect(r.committed.model).toBe("gamma-instance");
  expect(r.committed.identity).toBe("gamma-instance");
  expect(r.committed.fallback).toMatchObject({ primary: "omo-mini-local/gamma-instance", entries: ["omo-mini-local/beta"] });
  expect(JSON.parse(r.committed.settings).defaultModel).toBe("gamma-instance");
  expect(r.first.traffic).toEqual(["gamma-instance", "beta-instance"]);
  expect(r.first.active).toBe("beta-instance");
  expect(r.first.events).toContainEqual(expect.objectContaining({ type: "retry_fallback_applied",
    from: "omo-mini-local/gamma-instance", to: "omo-mini-local/beta-instance" }));
  expect(JSON.parse(r.settingsBefore).defaultModel).toBe("gamma-instance");
  expect(r.first.settings).toBe(r.settingsBefore);
}, 70000);

test("an approved downloaded key alias of the active instance cannot be its own fallback", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { parseArgs, prepareProfile } = await import("../src/profile.ts");
  const root = await mkdtemp(join(tmpdir(), "mini-native-self-alias-"));
  let inference = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/v1/models") return Response.json({ models: [{
      key: "alpha", type: "llm", capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "alpha-instance", config: { context_length: 65536 } }],
    }] });
    inference++; return new Response("not allowed", { status: 500 });
  } });
  try {
    await expect(prepareProfile(parseArgs(["rpc", "--root", root, "--state-dir", join(root, "state"),
      "--base-url", `http://127.0.0.1:${server.port}/v1`, "--native-local-fallback", "alpha"])))
      .rejects.toThrow("Fallback must differ from the primary model");
    expect(inference).toBe(0);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
