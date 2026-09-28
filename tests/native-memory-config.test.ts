import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { assertIsolatedMemoryRoot, parseArgs, prepareProfile, profileEnvironment, profilePaths } from "../src/profile.ts";

const generated = z.object({
  memory: z.object({
    enabled: z.boolean(), agent: z.string(), sync: z.object({ enabled: z.boolean() }),
    reflection: z.object({ enabled: z.boolean(), category: z.string() }),
    facts: z.object({ enabled: z.boolean() }), dream: z.object({ enabled: z.boolean() }),
    nudge: z.object({ enabled: z.boolean() }), search: z.object({ enabled: z.boolean() }),
    recall: z.object({ enabled: z.boolean(), category: z.string(), max_concurrent_wakes: z.number(), sidecar_max_tokens: z.number() }),
    compile_warn_tokens: z.number(),
  }),
  categories: z.object({ quick: z.object({ model: z.string(), models: z.array(z.string()), fallback_models: z.array(z.string()) }) }),
});

async function fixture(check: (root: string, args: string[]) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "omo-mini-memory-config-"));
  const root = join(base, "project");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/api/v1/models"
    ? Response.json({ models: [{ key: "memory-local", type: "llm", capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "memory-local", config: { context_length: 65536 } }] }] })
    : new Response("Not Found", { status: 404 }) });
  try {
    await mkdir(join(root, ".omo"), { recursive: true });
    await check(root, ["rpc", "--root", root, "--state-dir", join(base, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`]);
  } finally {
    server.stop(true);
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep)) throw new Error("Fixture escaped temporary directory");
    await rm(base, { recursive: true, force: true });
  }
}

test("native memory workers are enabled and pinned to the loaded local model", async () => fixture(async (_root, args) => {
  const profile = await prepareProfile(parseArgs(args));
  const config = generated.parse(JSON.parse(await readFile(join(profile.paths.home, ".omo", "omo.json"), "utf8")));
  for (const feature of [config.memory, config.memory.reflection, config.memory.facts, config.memory.dream, config.memory.nudge, config.memory.search, config.memory.recall]) {
    expect(feature.enabled).toBe(true);
  }
  expect(config.memory.sync.enabled).toBe(false);
  expect(profile.env["OMO_MINI_NATIVE_MEMORY_SYNC"]).toBe("0");
  expect(config.memory.reflection.category).toBe("quick");
  expect(config.memory.recall.category).toBe("quick");
  expect(config.categories.quick).toEqual({ model: "omo-mini-local/memory-local", models: ["omo-mini-local/memory-local"], fallback_models: [] });
  expect(config.memory.recall.max_concurrent_wakes).toBe(1);
  expect(config.memory.recall.sidecar_max_tokens).toBeLessThanOrEqual(16384);
  expect(config.memory.compile_warn_tokens).toBeLessThanOrEqual(8192);
}));

test("read-only profile does not start native memory writers", async () => fixture(async (_root, args) => {
  const profile = await prepareProfile(parseArgs([...args, "--permission", "read-only"]));
  const config = generated.parse(JSON.parse(await readFile(join(profile.paths.home, ".omo", "omo.json"), "utf8")));
  for (const feature of [config.memory.reflection, config.memory.facts, config.memory.dream]) expect(feature.enabled).toBe(false);
}));

test("project memory tuning keeps native features local and isolated", async () => fixture(async (root, args) => {
  const path = join(root, ".omo", "omo.json");
  await writeFile(path, JSON.stringify({ memory: { reflection: { trigger: { step_count: 2 } }, dream: { shutdown_launch: false }, recall: { enabled: false } } }));
  expect((await prepareProfile(parseArgs(args))).root).toBe(root);
  for (const override of [
    { memory: { sync: { enabled: true } } },
    { memory: { agent: "another-project" } },
    { memory: { agents: { shared: { enabled: true } } } },
    { memory: { reflection: { category: "deep" } } },
    { memory: { recall: { category: "deep" } } },
    { memory: { reflection: { unknown: true } } },
    { memory: { reflection: { trigger: { step_count: -1 } } } },
    { memory: { facts: { debounce_settles: 0 } } },
    { memory: { recall: { max_items: 6 } } },
    { memory: { unknown: true } },
    { categories: { quick: { model: "cloud/remote" } } },
    { categories: { quick: { models: ["omo-mini-local/memory-local", "cloud/remote"] } } },
    { "[native]": { categories: { quick: { fallback_models: ["cloud/remote"] } } } },
    { "[senpi]": { memory: { reflection: { enabled: true } } } },
  ]) {
    await writeFile(path, JSON.stringify(override));
    await expect(prepareProfile(parseArgs([...args, "--permission", "read-only"]))).rejects.toThrow("isolated local policy");
  }
}));

test("profile environment removes inherited native profile and config selectors", () => {
  const model = { id: "memory-local", state: "loaded", type: "llm", loaded_context_length: 65536, capabilities: ["tool_use"] };
  const env = profileEnvironment({ OMO_PROFILE: "shared", OCX_PROFILE: "shared",
    OPENCODE_CONFIG_DIR: "C:/shared/profiles/cloud", OCX_CONFIG_DIR: "C:/shared", OTHER: "kept" },
    profilePaths("C:/isolated"), model, "http://127.0.0.1:1234/v1", "C:/project");
  expect(env["OMO_PROFILE"]).toBeUndefined();
  expect(env["OCX_PROFILE"]).toBeUndefined();
  expect(env["OPENCODE_CONFIG_DIR"]).toBeUndefined();
  expect(env["OCX_CONFIG_DIR"]).toBeUndefined();
  expect(env["OTHER"]).toBe("kept");
});

test("explicit Native memory sync reaches only Mini's isolated config and local worker", async () => fixture(async (root, args) => {
  const profile = await prepareProfile(parseArgs([...args, "--native-memory-sync"]));
  const config = generated.parse(JSON.parse(await readFile(join(profile.paths.home, ".omo", "omo.json"), "utf8")));
  expect(config.memory.sync.enabled).toBe(true);
  expect(config.memory.agent).toBe("auto");
  expect(profile.env["OMO_MEMORY_HOME"]).toBe(profile.paths.memory);
  expect(profile.env["HOME"]).toBe(profile.paths.home);
  expect(profile.env["OMO_MINI_NATIVE_MEMORY_SYNC"]).toBe("1");
  expect(config.categories.quick.models).toEqual(["omo-mini-local/memory-local"]);
  const project = join(root, ".omo", "omo.json");
  for (const memory of [
    { sync: { enabled: false } }, { sync: { enabled: true, remote: "foreign" } },
    { agent: "foreign-identity" }, { agents: { shared: { sync: { enabled: true } } } },
    { reflection: { category: "cloud/remote" } },
  ]) {
    await writeFile(project, JSON.stringify({ memory }));
    await expect(prepareProfile(parseArgs([...args, "--native-memory-sync"]))).rejects.toThrow("isolated local policy");
  }
}));

test("memory sync requires an explicit writable session and never aliases global OmO", async () => fixture(async (root, args) => {
  expect(parseArgs(args).nativeMemorySync).toBe(false);
  expect(parseArgs([...args, "--native-memory-sync"]).nativeMemorySync).toBe(true);
  expect(() => parseArgs([...args, "--native-memory-sync", "--native-memory-sync"])).toThrow("Duplicate --native-memory-sync");
  expect(() => parseArgs([...args, "--permission", "read-only", "--native-memory-sync"])).toThrow("workspace permission");
  expect(() => parseArgs([...args, "--permission", "ask", "--native-memory-sync"])).toThrow("workspace permission");
  expect(() => parseArgs(["doctor", "--native-memory-sync"])).toThrow("requires an agent session");
  const fakeHome = join(dirname(root), "native-home");
  const global = join(fakeHome, ".omo");
  await mkdir(global, { recursive: true });
  expect(() => assertIsolatedMemoryRoot(join(global, "memory"), fakeHome)).toThrow("Mini-only");
  expect(() => assertIsolatedMemoryRoot(join(global, "other", "memory"), fakeHome)).toThrow("Mini-only");
  expect(() => assertIsolatedMemoryRoot(join(dirname(root), "mini-state", "memory"), fakeHome)).not.toThrow();
}));

