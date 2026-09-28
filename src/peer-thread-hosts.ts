import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHost, probeHost } from "@code-yeongyu/senpi";
import { z } from "zod";
import { listDownloadedModels } from "./lmstudio.ts";
import { MiniError } from "./local.ts";
import { loadForSelection } from "./model-admission.ts";
import { atomicJson, createPeerRecords, digest, inside, type HostRecord } from "./peer-thread-records.ts";
import { connectPeerHost, type Host } from "./peer-thread-rpc.ts";
import { identity } from "./policy.ts";
import { assertIsolatedProjectConfig, LOCAL_PROVIDER, localCategories, modelsConfig } from "./profile.ts";

const modelCatalog = z.object({
  providers: z.record(z.string(), z.object({
    models: z.array(z.object({
      id: z.string(),
      contextWindow: z.number().int().nonnegative(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();
const baseConfig = z.object({
  memory: z.unknown(),
  categories: z.record(z.string(), z.unknown()),
}).passthrough();
const canonical = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);

/**
 * Mini peers never share state with the user's OmO Native: every root is inside the
 * Mini state directory and outside the real home's global OmO/Senpi roots.
 */
function assertIsolatedPeerState(state: string, nativeHome: string, paths: readonly string[]): void {
  const reserved = [".omo", ".senpi", ".pi"].map(name => canonical(join(nativeHome, name)));
  for (const path of paths) {
    if (!inside(state, path))
      throw new MiniError("profile", `Mini peer state escaped its isolated state directory: ${path}`);
    if (reserved.some(root => inside(root, path) || inside(path, root)))
      throw new MiniError("profile", `Mini peer state overlaps global OmO Native state: ${path}`);
  }
}

export function createMiniPeerEnvironment() {
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new MiniError("profile", `Missing isolated Mini peer profile (${name})`);
    return value;
  };
  const state = realpathSync(env("OMO_MINI_PEER_STATE"));
  const agent = realpathSync(env("OMO_CODING_AGENT_DIR"));
  const home = realpathSync(env("HOME"));
  const sessions = realpathSync(env("OMO_MINI_PEER_SESSION_DIR"));
  const root = realpathSync(env("OMO_MINI_ROOT"));
  const miniExtension = resolve(env("OMO_MINI_PEER_EXTENSION"));
  assertIsolatedPeerState(state, canonical(env("OMO_MINI_NATIVE_HOME")), [agent, home, sessions]);
  const permission = z.enum(["workspace", "ask", "read-only"]).parse(process.env["OMO_MINI_PEER_PERMISSION"]);
  const extensions: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--extension") continue;
    const path = process.argv[++i];
    if (!path) throw new MiniError("profile", "Missing Native extension path");
    extensions.push(resolve(path));
  }
  if (!extensions.includes(miniExtension))
    throw new MiniError("profile", "Mini guard extension missing from Native launch");
  const extensionBytes = extensions.map(path => {
    const files = lstatSync(path).isDirectory()
      ? ["omo.js", "omo-task.js", "omo-member.js"].map(name => join(path, "extensions", name))
      : [path];
    return [path, ...files.map(file => digest(readFileSync(file).toString("base64")))];
  });
  const config = baseConfig.parse(Bun.JSONC.parse(readFileSync(join(home, ".omo", "omo.json"), "utf8")));
  const codeFile = fileURLToPath(import.meta.url);
  const codeFiles = codeFile.endsWith(".ts")
    ? ["peer-thread.ts", "peer-thread-rpc.ts", "peer-thread-records.ts", "peer-thread-move.ts", "peer-thread-hosts.ts"]
      .map(name => join(dirname(codeFile), name))
    : [codeFile]; // The built bundle contains every peer module.
  // Deterministic for the isolated profile: restarted callers rediscover the same hosts.
  const profile = digest(JSON.stringify({
    agent, root, permission, extensions: extensionBytes, memory: config.memory,
    peerCode: codeFiles.map(path => digest(readFileSync(path).toString("base64"))),
  })).slice(0, 24);
  const records = createPeerRecords(agent, sessions, profile);
  const active = new Map<string, Host>();
  const expectedExtensions = [...new Set(extensions)].sort();

  const verified = async (record: HostRecord) => {
    const info = await probeHost({ socket: record.socket });
    if (!info) return false;
    const actual = info.launch_profile?.core;
    if (info.instanceId !== record.instanceId || actual?.session_runtime !== "in-process" ||
        JSON.stringify(actual.extensions) !== JSON.stringify(expectedExtensions))
      throw new MiniError("profile", "Mini peer host ownership or extension profile changed");
    return true;
  };
  /** Attach only recorded, identity-verified Mini hosts; no other socket is ever probed. */
  const recover = async () => {
    for (const record of records.hostRecords()) {
      const alive = await verified(record);
      const attached = active.get(record.key);
      if (!alive) {
        if (attached) {
          active.delete(record.key);
          await attached.release();
        }
        continue;
      }
      if (!attached) active.set(record.key, await connectPeerHost(record.socket));
    }
  };
  // Native-cased on both sides so the Windows path comparison matches patched Native.
  const nativeHome = realpathSync.native(env("OMO_MINI_NATIVE_HOME")), isolatedHome = realpathSync.native(home);
  const current = () => identity(process.env);
  const admittedCwd = (requested?: string) => {
    const cwd = realpathSync.native(requested ?? root);
    const model = `${LOCAL_PROVIDER}/${current().model}`;
    const writable = permission !== "read-only";
    const sync = process.env["OMO_MINI_NATIVE_MEMORY_SYNC"] === "1";
    // Same layers patched Native merges: stop before the real or isolated home, include the drive root.
    for (let path = cwd; path !== nativeHome && path !== isolatedHome; path = dirname(path)) {
      const jsonc = join(path, ".omo", "omo.jsonc");
      const json = join(path, ".omo", "omo.json");
      if (existsSync(jsonc)) assertIsolatedProjectConfig(jsonc, model, writable, sync);
      else if (existsSync(json)) assertIsolatedProjectConfig(json, model, writable, sync);
      if (dirname(path) === path) break;
    }
    return cwd;
  };
  const hostHome = (key: string, modelId: string) => {
    const peerHome = join(records.directory, "homes", digest(key));
    const profilePath = join(peerHome, ".omo", "omo.json");
    if (!existsSync(profilePath))
      atomicJson(profilePath, { ...config, categories: localCategories(`${LOCAL_PROVIDER}/${modelId}`) });
    return peerHome;
  };
  const eligible = async (id: string, baseUrl: string) => {
    const selected = await loadForSelection(id);
    const context = selected.loaded_context_length;
    if (!context) throw new MiniError("model_unavailable", "Peer local model has no accepted context");
    const next = modelsConfig(selected, baseUrl, await listDownloadedModels(baseUrl));
    const modelsPath = join(agent, "models.json");
    const existing = modelCatalog.parse(JSON.parse(readFileSync(modelsPath, "utf8")));
    const provider = existing.providers[LOCAL_PROVIDER];
    if (!provider || Object.keys(existing.providers).some(name => name !== LOCAL_PROVIDER))
      throw new MiniError("profile", "Nonlocal or missing provider in isolated Mini model catalog");
    if (!provider.models.some(item => item.id === selected.id && item.contextWindow === context)) {
      const entry = next.providers[LOCAL_PROVIDER].models.find(item => item.id === selected.id);
      if (!entry) throw new MiniError("profile", "Accepted local model was not added to the catalog");
      atomicJson(modelsPath, {
        ...existing,
        providers: {
          ...existing.providers,
          [LOCAL_PROVIDER]: { ...provider, models: [...provider.models.filter(item => item.id !== selected.id), entry] },
        },
      });
    }
    return { id: selected.id, context };
  };
  /** Ensure the immutable guard host for one local model, context and cwd. */
  const start = async (modelId: string, context: number, baseUrl: string, cwd: string) => {
    const key = records.hostKey(modelId, context, baseUrl, cwd);
    const socket = records.hostSocket(key);
    await recover();
    const old = records.hostRecords().find(item => item.key === key);
    const peerHome = hostHome(key, modelId);
    const environment = {
      ...process.env,
      OMO_MINI_MODEL: modelId,
      OMO_MINI_CONTEXT: String(context),
      OMO_MINI_LOADED: "1",
      OMO_MINI_ROOT: cwd,
      OMO_RPC_SOCKET: socket,
      HOME: peerHome,
      USERPROFILE: peerHome,
    };
    const option = process.argv.indexOf("--permission");
    const rule = option >= 0 ? process.argv[option + 1] : undefined;
    const hostArgs = [
      "--offline", "--no-model-fallback", "--no-recommended-models",
      "--session-runtime", "in-process", "--session-dir", sessions,
      "--provider", LOCAL_PROVIDER, "--model", modelId,
      "--permission-preset", permission, "--omo-senpi-onboarding-disabled",
      ...(process.argv.includes("--omo-senpi-telemetry-disabled") ? ["--omo-senpi-telemetry-disabled"] : []),
      ...(rule ? ["--permission", rule] : []),
      ...extensions.flatMap(path => ["--extension", path]),
    ];
    const result = await ensureHost({ socket, agentDir: agent, hostArgs, env: environment, upgrade: "never" });
    const info = await probeHost({ socket });
    if (!info?.instanceId || info.launch_profile?.core?.session_runtime !== "in-process" ||
        JSON.stringify(info.launch_profile.core.extensions) !== JSON.stringify(expectedExtensions) ||
        (result.reused && (!old || old.instanceId !== info.instanceId)))
      throw new MiniError("profile", "Refusing to attach an unverified Mini peer host");
    const record: HostRecord = {
      version: 1, key, profile, socket, instanceId: info.instanceId, modelId, context, baseUrl, cwd,
    };
    atomicJson(records.hostFile(key), record);
    let host = active.get(key);
    if (!host) {
      host = await connectPeerHost(socket);
      active.set(key, host);
    }
    return { key, host };
  };
  return { agent, sessions, root, permission, profile, records, active, current, admittedCwd, eligible, start, recover };
}
