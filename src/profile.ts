import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { discover, endpoint, MINI_IDENTITY, MiniError, outputLimit } from "./local.ts";
import type { LocalModel } from "./local.ts";
import { listDownloadedModels, loadModel, type DownloadedModel } from "./lmstudio.ts";
import { isolatedMemoryOverride } from "./memory-config.ts";

export const LOCAL_PROVIDER = "omo-mini-local";
export const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const require = createRequire(import.meta.url);

export function localEndpoint(baseUrl: string): URL {
  const url = endpoint(baseUrl);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new MiniError("base_url", "omo-mini requires a loopback HTTP model endpoint");
  return url;
}

export function profilePaths(stateDir = join(homedir(), ".omo-mini")) {
  const state = resolve(stateDir);
  return { state, home: join(state, "home"), agent: join(state, "agent"), sessions: join(state, "sessions"), memory: join(state, "memory") };
}

// Printed by the patched Native exit path instead of `omo --session-dir ... --session ...`: sessions stay in Mini's state dir.
export function resumeHint(root: string, state: string): string {
  const arg = (value: string) => /[\s"'&|<>^%]/.test(value) ? `"${value}"` : value;
  return `omo-mini --root ${arg(root)} --state-dir ${arg(state)}, then /resume`;
}

// Resolve existing parents before mkdir so a symlink cannot alias global memory.
function projectedRealpath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new MiniError("config", "Cannot resolve isolated memory root");
    missing.unshift(basename(current)); current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}
export function assertIsolatedMemoryRoot(memory: string, nativeHome = homedir()): void {
  const candidate = projectedRealpath(memory);
  for (const reserved of [join(nativeHome, ".omo"), join(nativeHome, ".omo", "memory")]) {
    const rel = relative(projectedRealpath(reserved), candidate);
    if (!rel || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      throw new MiniError("config", "Native memory sync requires a Mini-only state directory outside global OmO memory");
  }
}

export function profileEnvironment(original: NodeJS.ProcessEnv, paths: ReturnType<typeof profilePaths>, selected: LocalModel, baseUrl: string, root: string, nativeMemorySync = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(original)) {
    // No inherited provider credentials, engine or OmO configuration overrides.
    if (!/^(CONTEXT7_API_KEY|GREP_APP_API_KEY)$/i.test(key) && /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN|_BEARER_TOKEN|_SECRET|_PASSWORD|_TOKEN|_CODING_AGENT_DIR|_SESSION_DIR|_BRAND|_BIN)$/i.test(key) ||
        /^(PI_|OMO_|OCX_|OPENCODE_|SENPI_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|AWS_|XAI_|OPENROUTER_|OLLAMA_|QWEN_)/i.test(key)) continue;
    env[key] = value;
  }
  env["HOME"] = paths.home;
  env["USERPROFILE"] = paths.home;
  // Bun follows USERPROFILE for os.userInfo().homedir, so remapping it drops the real
  // home as Native's project-config boundary; patched Native stops at this path instead.
  env["OMO_MINI_NATIVE_HOME"] = realpathSync.native(homedir());
  env["OMO_CODING_AGENT_DIR"] = paths.agent;
  env["SENPI_CODING_AGENT_DIR"] = paths.agent;
  env["PI_CODING_AGENT_DIR"] = paths.agent;
  env["OMO_MEMORY_HOME"] = paths.memory;
  env["OMO_MINI_MODEL"] = selected.state === "loaded" ? selected.id : "";
  env["OMO_MINI_CONTEXT"] = String(selected.loaded_context_length);
  env["OMO_MINI_LOADED"] = selected.state === "loaded" ? "1" : "0";
  env["OMO_MINI_LIFECYCLE_PATH"] = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./model-admission.ts" : "./model-admission.js", import.meta.url));
  env["OMO_MINI_BASE_URL"] = new URL("/v1", baseUrl).href;
  env["OMO_MINI_ROOT"] = root;
  env["PI_OFFLINE"] = "1";
  env["OMO_MINI_LOCAL_PROFILE"] = "1";
  env["OMO_MINI_NATIVE_MEMORY_SYNC"] = nativeMemorySync ? "1" : "0";
  env["OMO_MEMORY_RUN_SUPERVISOR_PATH"] = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./reflection-supervisor.ts" : "./reflection-supervisor.js", import.meta.url));
  return env;
}

export function modelsConfig(model: LocalModel, baseUrl: string, downloaded: readonly DownloadedModel[] = []) {
  const context = model.loaded_context_length;
  if (!context && model.state === "loaded") throw new MiniError("model_unavailable", "Loaded context missing");
  const entries = downloaded.flatMap(item => [
    // Native requires a positive catalog context to expose a model in /model.
    // This is a real downloaded key, but one token is deliberately unusable;
    // only loadForSelection may replace it with an inspected instance/context.
    { id: item.key, context: 1, vision: item.capabilities.vision },
    ...item.loaded_instances.map(instance => ({ id: instance.id, context: instance.context_length, vision: item.capabilities.vision })),
  ]);
  if (!entries.some(entry => entry.id === model.id)) entries.unshift({ id: model.id, context: context ?? 0, vision: model.type === "vlm" });
  const unique = new Map(entries.map(entry => [entry.id, entry]));
  return { providers: { [LOCAL_PROVIDER]: {
    baseUrl: new URL("/v1", baseUrl).href, api: "openai-completions", apiKey: "local",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [...unique.values()].map(entry => ({ id: entry.id, name: entry.id, reasoning: false,
      input: entry.vision ? ["text", "image"] : ["text"],
      contextWindow: entry.context, maxTokens: outputLimit(entry.context),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  } } };
}

export function upstreamEntry(): string {
  return resolve(require.resolve("omo-ai/package.json"), "..", "bin", "omo.js");
}

export const LOCAL_CATEGORIES = ["quick", "unspecified-low", "unspecified-high", "deep-low", "deep-high", "ultrabrain", "visual-engineering", "writing", "architect", "artistry"] as const;
export function localCategories(model: string) {
  return Object.fromEntries(LOCAL_CATEGORIES.map(name => [name, { model, models: [model], fallback_models: [] }]));
}

function nativeMemoryConfig(context: number, writable: boolean, nativeMemorySync: boolean) {
  return { enabled: true, agent: "auto", sync: { enabled: nativeMemorySync },
    reflection: { enabled: writable, category: "quick" }, facts: { enabled: writable }, dream: { enabled: writable },
    nudge: { enabled: true }, search: { enabled: true },
    recall: { enabled: true, category: "quick", max_concurrent_wakes: 1, sidecar_max_tokens: Math.max(1024, Math.min(16384, Math.floor(context / 4))) },
    compile_warn_tokens: Math.max(1024, Math.min(8192, Math.floor(context / 8))),
  };
}
export function assertIsolatedProjectConfig(path: string, model: string, writable: boolean, nativeMemorySync: boolean): void {
  let config: unknown;
  try { config = Bun.JSONC.parse(readFileSync(path, "utf8")); }
  catch { return; } // OmO ignores malformed project config; no override is applied.
  const record = z.record(z.string(), z.unknown());
  const parsed = record.safeParse(config);
  if (!parsed.success) return;
  const memory = isolatedMemoryOverride(writable, nativeMemorySync);
  const category = z.object({ model: z.literal(model).optional(), models: z.array(z.literal(model)).nonempty().optional(),
    fallback_models: z.array(z.literal(model)).optional() }).strict();
  for (const candidate of [parsed.data, parsed.data["[native]"], parsed.data["[senpi]"]]) {
    const layer = record.safeParse(candidate);
    if (!layer.success) continue;
    const categories = record.safeParse(layer.data["categories"]);
    if (layer.data["memory"] !== undefined && !memory.safeParse(layer.data["memory"]).success ||
        categories.success && categories.data["quick"] !== undefined && !category.safeParse(categories.data["quick"]).success)
      throw new MiniError("config", `Project OmO memory override would break the isolated local policy at ${path}`);
  }
}

const optionsSchema = z.object({
  command: z.enum(["doctor", "run", "rpc", "interactive", "help"]),
  baseUrl: z.string(), root: z.string(), stateDir: z.string().optional(), model: z.string().optional(),
  task: z.string().optional(), image: z.string().optional(), session: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), json: z.boolean(), nativeTelemetry: z.boolean().default(false),
  nativeMemorySync: z.boolean().default(false), nativeLocalFallback: z.array(z.string()).default([]),
  permission: z.enum(["workspace", "ask", "read-only"]).default("workspace"),
});
export type Options = z.infer<typeof optionsSchema>;

export function parseArgs(args: readonly string[]): Options {
  const first = args[0];
  const command = first === "run" || first === "doctor" || first === "rpc" ? first : first === "--help" || first === "-h" || first === "help" ? "help" : "interactive";
  const values = new Map<string, string>();
  let json = false, nativeTelemetry = false, nativeMemorySync = false;
  const nativeLocalFallback: string[] = [];
  const items = command === "interactive" ? args : args.slice(1);
  for (let i = 0; i < items.length; i++) {
    const flag = items[i];
    if (flag === "--help" || flag === "-h") return optionsSchema.parse({ command: "help", baseUrl: DEFAULT_BASE_URL, root: process.cwd(), json: false });
    if (flag === "--json") { if (json) throw new MiniError("arguments", "Duplicate --json"); json = true; continue; }
    if (flag === "--native-telemetry") { if (nativeTelemetry) throw new MiniError("arguments", "Duplicate --native-telemetry"); nativeTelemetry = true; continue; }
    if (flag === "--native-memory-sync") { if (nativeMemorySync) throw new MiniError("arguments", "Duplicate --native-memory-sync"); nativeMemorySync = true; continue; }
    if (flag === "--native-local-fallback") {
      const id = items[++i];
      if (!id || id.startsWith("--") || nativeLocalFallback.includes(id)) throw new MiniError("arguments", "Invalid or duplicate --native-local-fallback ID");
      nativeLocalFallback.push(id); continue;
    }
    if (!flag || !["--root", "--state-dir", "--base-url", "--model", "--task", "--image", "--session", "--permission"].includes(flag) || values.has(flag) || !items[i + 1])
      throw new MiniError("arguments", `Unsupported or missing option: ${flag}`);
    values.set(flag, items[++i] ?? "");
  }
  if (command === "run" && !values.has("--task")) throw new MiniError("arguments", "run requires --task");
  if (command !== "run" && values.has("--session")) throw new MiniError("arguments", "--session requires run");
  if (command !== "run" && (values.has("--task") || values.has("--image"))) throw new MiniError("arguments", "--task and --image require run");
  if (command !== "run" && command !== "doctor" && json) throw new MiniError("arguments", "--json requires run or doctor");
  if (command === "doctor" && nativeTelemetry) throw new MiniError("arguments", "--native-telemetry requires an agent session");
  if (command === "doctor" && nativeMemorySync) throw new MiniError("arguments", "--native-memory-sync requires an agent session");
  const result = optionsSchema.safeParse({ command, baseUrl: values.get("--base-url") ?? DEFAULT_BASE_URL,
    root: values.get("--root") ?? process.cwd(), stateDir: values.get("--state-dir"), model: values.get("--model"),
    task: values.get("--task"), image: values.get("--image"), session: values.get("--session"), json, nativeTelemetry, nativeMemorySync, nativeLocalFallback, permission: values.get("--permission") });
  if (!result.success) throw new MiniError("arguments", result.error.message);
  if (result.data.nativeMemorySync && result.data.permission !== "workspace")
    throw new MiniError("permission", "Native memory sync requires workspace permission");
  localEndpoint(result.data.baseUrl);
  return result.data;
}

export async function prepareProfile(options: Options) {
  const paths = profilePaths(options.stateDir);
  if (options.nativeMemorySync) {
    if (options.permission !== "workspace") throw new MiniError("permission", "Native memory sync requires workspace permission");
    assertIsolatedMemoryRoot(paths.memory);
  }
  let savedModel: string | undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(join(paths.agent, "settings.json"), "utf8"));
    const parsed = z.object({ defaultProvider: z.string().optional(), defaultModel: z.string().optional() }).passthrough().safeParse(raw);
    if (!parsed.success) throw new MiniError("config", "Invalid isolated Native settings.json");
    if (parsed.data.defaultProvider === LOCAL_PROVIDER) savedModel = parsed.data.defaultModel;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let downloaded: DownloadedModel[] = [];
  let legacyCatalog = false;
  try { downloaded = await listDownloadedModels(options.baseUrl); }
  catch (error) {
    if (!(error instanceof MiniError) || error.code !== "endpoint") throw error;
    // The v0 compatibility path applies only to servers without a v1 route.
    const route = endpoint(options.baseUrl); route.pathname = "/api/v1/models";
    if ((await fetch(route, { signal: AbortSignal.timeout(5000) })).status !== 404) throw error;
    legacyCatalog = true;
  }
  if (options.nativeLocalFallback.length && !downloaded.length)
    throw new MiniError("endpoint", "Explicit local fallback requires LM Studio /api/v1/models");
  for (const id of options.nativeLocalFallback) {
    if (!downloaded.some(item => item.key === id || item.loaded_instances.some(instance => instance.id === id)))
      throw new MiniError("model_unavailable", `Fallback ${id} is not an eligible downloaded local model`);
  }
  let model: LocalModel;
  if (downloaded.length === 0) {
    if (!legacyCatalog) throw new MiniError("no_downloaded_model", "No eligible downloaded chat model in LM Studio");
    // Legacy v0 cannot list downloaded models. An unloaded server needs v1.
    try { model = await discover(options.baseUrl, options.model ?? savedModel); }
    catch (error) {
      if (error instanceof MiniError && error.code === "model_selection")
        throw new MiniError("endpoint", "LM Studio /api/v1/models is required to use /model with nothing loaded");
      throw error;
    }
  } else {
    const requested = options.model ?? savedModel;
    const remembered = requested ? downloaded.find(item => item.key === requested || item.loaded_instances.some(instance => instance.id === requested)) : undefined;
    if (options.model && !remembered) throw new MiniError("model_unavailable", `Downloaded model ${options.model} not found`);
    const selected = remembered ?? (savedModel && !options.model ? downloaded[0] : undefined) ??
      downloaded.find(item => item.loaded_instances.length > 0) ?? downloaded[0];
    if (!selected) throw new MiniError("no_downloaded_model", "No eligible downloaded chat model in LM Studio");
    // An unavailable saved instance must never silently fall back to another loaded model.
    const loaded = remembered || !savedModel || options.model
      ? selected.loaded_instances.find(item => item.id === requested) ?? (requested === selected.key || !requested ? selected.loaded_instances[0] : undefined)
      : undefined;
    if (loaded) model = { id: loaded.id, state: "loaded", type: selected.capabilities.vision ? "vlm" : "llm",
      loaded_context_length: loaded.context_length, capabilities: ["tool_use"] };
    else if (options.command === "run" && options.model) model = await loadModel(options.baseUrl, selected.key);
    else if (options.command === "run") throw new MiniError("model_selection", "No model loaded; select one through /model or pass --model");
    else model = { id: selected.key, state: "downloaded", type: selected.capabilities.vision ? "vlm" : "llm",
      loaded_context_length: 0, capabilities: ["tool_use"] };
  }
  const primaryKey = downloaded.find(item => item.key === model.id || item.loaded_instances.some(instance => instance.id === model.id))?.key;
  const approvedFallback = options.nativeLocalFallback.map(id => ({
    selector: `${LOCAL_PROVIDER}/${id}`,
    key: downloaded.find(item => item.key === id || item.loaded_instances.some(instance => instance.id === id))!.key,
  }));
  if (approvedFallback.length && !approvedFallback.some(entry => entry.key !== primaryKey))
    throw new MiniError("arguments", "Fallback must differ from the primary model");
  const memoryModel = `${LOCAL_PROVIDER}/${model.id}`;
  const writableMemory = options.permission !== "read-only";
  const root = resolve(options.root);
  const nativeHome = realpathSync.native(homedir());
  if (!isAbsolute(root)) throw new MiniError("workspace", "Workspace must be absolute");
  // OmO reads project .omo configs independently of Senpi's --no-approve.
  // The remapped home is not an ancestor of the workspace; even the real home
  // can be a project layer. Validate every ancestor OmO can merge: like patched Native,
  // stop before the real or isolated home and include the drive root.
  for (let path = root; path !== nativeHome && path !== paths.home; path = dirname(path)) {
    const jsonc = join(path, ".omo", "omo.jsonc"), json = join(path, ".omo", "omo.json");
    if (existsSync(jsonc)) assertIsolatedProjectConfig(jsonc, memoryModel, writableMemory, options.nativeMemorySync);
    else if (existsSync(json)) assertIsolatedProjectConfig(json, memoryModel, writableMemory, options.nativeMemorySync);
    if (dirname(path) === path) break;
  }
  await Promise.all([mkdir(join(paths.home, ".omo"), { recursive: true }), mkdir(paths.agent, { recursive: true }), mkdir(paths.sessions, { recursive: true }), mkdir(paths.memory, { recursive: true })]);
  // OmO loads $HOME/.omo/omo.json before project config. The isolated HOME and
  // memory preflight prevent unsafe overrides; --no-approve excludes Senpi resources.
  await writeFile(join(paths.home, ".omo", "omo.json"), JSON.stringify({
    memory: nativeMemoryConfig(model.loaded_context_length ?? 4096, writableMemory, options.nativeMemorySync),
    categories: localCategories(memoryModel),
    // Native keeps task records and session locks in <cwd>/.omo/senpi-task by default. That
    // workspace .omo trips Native's project config watcher mid-turn; keep them in Mini state.
    // Native's "auto" mode starts task children as separate processes on Linux/macOS (in-process
    // on Windows). Those children do not get this launcher's flags, so Native's first-run
    // onboarding sent an unrequested local inference turn before the delegated prompt.
    task: { state_dir: join(paths.state, "senpi-task"), default_execution_mode: "in-process" },
  }, null, 2) + "\n");
  await writeFile(join(paths.agent, "models.json"), JSON.stringify(modelsConfig(model, options.baseUrl, downloaded), null, 2) + "\n");
  // A 9B local model cannot afford the upstream 16K compaction and 20K recent-history defaults.
  // Native compaction still owns whole-message/tool-pair selection; never splice transcript entries here.
  let settings;
  try { settings = await open(join(paths.agent, "settings.json"), "wx"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") settings = undefined;
    else throw error;
  }
  if (settings) {
    try { await settings.writeFile(JSON.stringify({ compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 4096 },
      permission: { powershell: { "Remove-Item *": "deny" } } }, null, 2) + "\n"); }
    finally { await settings.close(); }
  }
  const env = profileEnvironment(process.env, paths, model, options.baseUrl, root, options.nativeMemorySync);
  env["OMO_MINI_RESUME_HINT"] = resumeHint(root, paths.state);
  env["OMO_MINI_IDENTITY"] = MINI_IDENTITY;
  // OmO reads --omo-senpi-telemetry-disabled before Senpi applies CLI flag values, so the flag is inert;
  // DO_NOT_TRACK is the opt-out every Native PostHog path checks when it runs.
  if (!options.nativeTelemetry) env["DO_NOT_TRACK"] = "1";
  if (approvedFallback.length) env["OMO_MINI_LOCAL_FALLBACK"] = JSON.stringify({
    primary: `${LOCAL_PROVIDER}/${model.id}`,
    entries: approvedFallback.filter(entry => entry.key !== primaryKey).map(entry => entry.selector),
    approved: approvedFallback,
  });
  return { model, root, paths, env };
}
