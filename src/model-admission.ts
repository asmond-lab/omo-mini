import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { listDownloadedModels, loadModel } from "./lmstudio.ts";
import { MiniError, outputLimit, type LocalModel } from "./local.ts";
import { LOCAL_CATEGORIES, LOCAL_PROVIDER, modelsConfig } from "./profile.ts";

const localModelEntry = z.object({ id: z.string(), name: z.string(), reasoning: z.boolean(), input: z.array(z.string()),
  contextWindow: z.number(), maxTokens: z.number(), cost: z.record(z.string(), z.number()) });
const storedModels = z.object({ providers: z.record(z.string(), z.object({ models: z.array(localModelEntry) }).passthrough()) }).passthrough();
// OmO's on-disk migration normalizes a category to { models: [...] } and strips
// the legacy model/fallback_models fields. Both shapes must remain writable.
const storedHome = z.object({ categories: z.record(z.string(), z.object({ model: z.string().optional(), models: z.array(z.string()).optional(),
  fallback_models: z.array(z.string()).optional() }).passthrough()) }).passthrough();

function baseUrl(): string {
  const url = process.env["OMO_MINI_BASE_URL"];
  if (!url) throw new MiniError("profile", "Missing local LM Studio endpoint");
  return url;
}

/** Invoked by Native's real picker refresh; PI_OFFLINE only disables remote catalog fetches. */
export async function catalogModels(signal?: AbortSignal) {
  const downloaded = await listDownloadedModels(baseUrl(), signal);
  if (!downloaded.length) return [];
  const first = downloaded[0]!;
  const instance = first.loaded_instances[0];
  const sample: LocalModel = { id: instance?.id ?? first.key, state: instance ? "loaded" : "downloaded",
    type: first.capabilities.vision ? "vlm" : "llm", loaded_context_length: instance?.context_length ?? 0, capabilities: ["tool_use"] };
  return modelsConfig(sample, baseUrl(), downloaded).providers[LOCAL_PROVIDER].models;
}

/** Load and inspect without changing Native registry, selected model, env or disk. */
const inspected = new Map<string, { key: string; context: number }>();
export async function loadForSelection(id: string, signal?: AbortSignal): Promise<LocalModel> {
  const catalog = await listDownloadedModels(baseUrl(), signal);
  const item = catalog.find(entry => entry.key === id || entry.loaded_instances.some(instance => instance.id === id));
  if (!item) throw new MiniError("model_unavailable", `Downloaded local model ${id} is no longer available`);
  const instance = item.loaded_instances.find(entry => entry.id === id);
  const loaded: LocalModel = instance
    ? { id: instance.id, state: "loaded", type: item.capabilities.vision ? "vlm" : "llm",
      loaded_context_length: instance.context_length, capabilities: ["tool_use"] }
    : await loadModel(baseUrl(), item.key, signal);
  if (!loaded.loaded_context_length || signal?.aborted) throw new MiniError("model_unavailable", `Local model ${id} was not admitted`);
  inspected.set(loaded.id, { key: item.key, context: loaded.loaded_context_length });
  return loaded;
}


/** Stage both isolated files; Native commits only after post-hook context admission. */
export function stageSelection(model: LocalModel, manual = false) {
  const home = process.env["HOME"], agent = process.env["OMO_CODING_AGENT_DIR"];
  if (!home || !agent || !model.loaded_context_length) throw new MiniError("profile", "Missing isolated model profile");
  const homePath = join(home, ".omo", "omo.json"), modelsPath = join(agent, "models.json");
  const oldHome = readFileSync(homePath, "utf8"), oldModels = readFileSync(modelsPath, "utf8");
  const config = storedHome.parse(JSON.parse(oldHome));
  const catalog = storedModels.parse(JSON.parse(oldModels));
  const provider = catalog.providers[LOCAL_PROVIDER];
  if (!provider) throw new MiniError("profile", "Missing isolated local provider");
  const oldFallback = process.env["OMO_MINI_LOCAL_FALLBACK"];
  let nextFallback: string | undefined;
  if (manual && oldFallback) {
    const inspection = inspected.get(model.id);
    if (!inspection || inspection.context !== model.loaded_context_length)
      throw new MiniError("model_unavailable", `Uninspected manual model ${model.id}`);
    const policy = z.object({ primary: z.string(), entries: z.array(z.string()),
      approved: z.array(z.object({ selector: z.string(), key: z.string() })) }).parse(JSON.parse(oldFallback));
    nextFallback = JSON.stringify({ ...policy, primary: `${LOCAL_PROVIDER}/${model.id}`,
      entries: policy.approved.filter(entry => entry.key !== inspection.key).map(entry => entry.selector) });
  }
  const ref = `${LOCAL_PROVIDER}/${model.id}`;
  for (const category of LOCAL_CATEGORIES) {
    const current = config.categories[category] ?? {};
    config.categories[category] = { ...current, models: [ref],
      ...(current.model === undefined ? {} : { model: ref }),
      ...(current.fallback_models === undefined ? {} : { fallback_models: [] }) };
  }
  provider.models = provider.models.filter(entry => entry.id !== model.id);
  provider.models.push({ id: model.id, name: model.id, reasoning: false,
    input: model.type === "vlm" ? ["text", "image"] : ["text"], contextWindow: model.loaded_context_length,
    maxTokens: outputLimit(model.loaded_context_length), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const tempHome = `${homePath}.${process.pid}.tmp`, tempModels = `${modelsPath}.${process.pid}.tmp`;
  const oldIdentity = { model: process.env["OMO_MINI_MODEL"], context: process.env["OMO_MINI_CONTEXT"], loaded: process.env["OMO_MINI_LOADED"] };
  let committed = false;
  writeFileSync(tempHome, JSON.stringify(config, null, 2) + "\n");
  writeFileSync(tempModels, JSON.stringify(catalog, null, 2) + "\n");
  const restore = (path: string, value: string) => { const temporary = `${path}.${process.pid}.restore.tmp`; writeFileSync(temporary, value); renameSync(temporary, path); };
  return {
    commit() {
      renameSync(tempModels, modelsPath);
      renameSync(tempHome, homePath);
      process.env["OMO_MINI_MODEL"] = model.id;
      process.env["OMO_MINI_CONTEXT"] = String(model.loaded_context_length);
      process.env["OMO_MINI_LOADED"] = "1";
      if (nextFallback !== undefined) process.env["OMO_MINI_LOCAL_FALLBACK"] = nextFallback;
      committed = true;
    },
    rollback() {
      // Restore even when only one rename landed. Failed/cancelled switches must
      // never leave a child catalog or route pointing at an unadmitted instance.
      try { restore(modelsPath, oldModels); restore(homePath, oldHome); }
      finally {
        for (const [key, value] of Object.entries({ OMO_MINI_MODEL: oldIdentity.model, OMO_MINI_CONTEXT: oldIdentity.context, OMO_MINI_LOADED: oldIdentity.loaded })) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        if (oldFallback === undefined) delete process.env["OMO_MINI_LOCAL_FALLBACK"];
        else process.env["OMO_MINI_LOCAL_FALLBACK"] = oldFallback;
        rmSync(tempHome, { force: true }); rmSync(tempModels, { force: true });
        committed = false;
      }
    },
    finish() { if (!committed) { rmSync(tempHome, { force: true }); rmSync(tempModels, { force: true }); } },
  };
}
