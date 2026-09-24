import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { z } from "zod";
import { discover, endpoint, MiniError } from "./local.ts";
import type { LocalModel } from "./local.ts";

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
  return { state, home: join(state, "home"), agent: join(state, "agent"), sessions: join(state, "sessions") };
}

export function profileEnvironment(original: NodeJS.ProcessEnv, paths: ReturnType<typeof profilePaths>, selected: LocalModel, baseUrl: string, root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(original)) {
    // No inherited provider credentials, engine or OmO configuration overrides.
    if (/(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN|_BEARER_TOKEN|_SECRET|_PASSWORD|_TOKEN|_CODING_AGENT_DIR|_SESSION_DIR|_BRAND|_BIN)$/i.test(key) ||
        /^(PI_|OMO_|SENPI_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|AWS_|XAI_|OPENROUTER_|OLLAMA_|QWEN_)/i.test(key)) continue;
    env[key] = value;
  }
  env["HOME"] = paths.home;
  env["USERPROFILE"] = paths.home;
  env["OMO_CODING_AGENT_DIR"] = paths.agent;
  env["SENPI_CODING_AGENT_DIR"] = paths.agent;
  env["PI_CODING_AGENT_DIR"] = paths.agent;
  env["OMO_MINI_MODEL"] = selected.id;
  env["OMO_MINI_CONTEXT"] = String(selected.loaded_context_length);
  env["OMO_MINI_BASE_URL"] = new URL("/v1", baseUrl).href;
  env["OMO_MINI_ROOT"] = root;
  env["PI_OFFLINE"] = "1";
  env["OMO_MINI_LOCAL_PROFILE"] = "1";
  return env;
}

export function modelsConfig(model: LocalModel, baseUrl: string) {
  const context = model.loaded_context_length;
  if (!context) throw new MiniError("model_unavailable", "Loaded context missing");
  return { providers: { [LOCAL_PROVIDER]: {
    baseUrl: new URL("/v1", baseUrl).href, api: "openai-completions", apiKey: "local",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{ id: model.id, name: model.id, reasoning: false,
      input: model.type === "vlm" ? ["text", "image"] : ["text"],
      contextWindow: context, maxTokens: Math.min(2048, context - 3072),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } };
}

export function upstreamEntry(): string {
  return resolve(require.resolve("omo-ai/package.json"), "..", "bin", "omo.js");
}

const optionsSchema = z.object({
  command: z.enum(["doctor", "run", "rpc", "interactive", "help"]),
  baseUrl: z.string(), root: z.string(), stateDir: z.string().optional(), model: z.string().optional(),
  task: z.string().optional(), image: z.string().optional(), session: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), json: z.boolean(),
  permission: z.enum(["workspace", "ask", "read-only"]).default("workspace"),
});
export type Options = z.infer<typeof optionsSchema>;

export function parseArgs(args: readonly string[]): Options {
  const first = args[0];
  const command = first === "run" || first === "doctor" || first === "rpc" ? first : first === "--help" || first === "-h" || first === "help" ? "help" : "interactive";
  const values = new Map<string, string>();
  let json = false;
  const items = command === "interactive" ? args : args.slice(1);
  for (let i = 0; i < items.length; i++) {
    const flag = items[i];
    if (flag === "--help" || flag === "-h") return optionsSchema.parse({ command: "help", baseUrl: DEFAULT_BASE_URL, root: process.cwd(), json: false });
    if (flag === "--json") { if (json) throw new MiniError("arguments", "Duplicate --json"); json = true; continue; }
    if (!flag || !["--root", "--state-dir", "--base-url", "--model", "--task", "--image", "--session", "--permission"].includes(flag) || values.has(flag) || !items[i + 1])
      throw new MiniError("arguments", `Unsupported or missing option: ${flag}`);
    values.set(flag, items[++i] ?? "");
  }
  if (command === "run" && !values.has("--task")) throw new MiniError("arguments", "run requires --task");
  if (command !== "run" && values.has("--session")) throw new MiniError("arguments", "--session requires run");
  if (command !== "run" && (values.has("--task") || values.has("--image"))) throw new MiniError("arguments", "--task and --image require run");
  if (command === "interactive" && json) throw new MiniError("arguments", "--json requires run or doctor");
  const result = optionsSchema.safeParse({ command, baseUrl: values.get("--base-url") ?? DEFAULT_BASE_URL,
    root: values.get("--root") ?? process.cwd(), stateDir: values.get("--state-dir"), model: values.get("--model"),
    task: values.get("--task"), image: values.get("--image"), session: values.get("--session"), json, permission: values.get("--permission") });
  if (!result.success) throw new MiniError("arguments", result.error.message);
  localEndpoint(result.data.baseUrl);
  return result.data;
}

export async function prepareProfile(options: Options) {
  const model = await discover(options.baseUrl, options.model);
  const root = resolve(options.root);
  if (!isAbsolute(root)) throw new MiniError("workspace", "Workspace must be absolute");
  const paths = profilePaths(options.stateDir);
  await Promise.all([mkdir(paths.home, { recursive: true }), mkdir(paths.agent, { recursive: true }), mkdir(paths.sessions, { recursive: true })]);
  await writeFile(join(paths.agent, "models.json"), JSON.stringify(modelsConfig(model, options.baseUrl), null, 2) + "\n");
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
  return { model, root, paths, env: profileEnvironment(process.env, paths, model, options.baseUrl, root) };
}
