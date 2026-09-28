import { z } from "zod";
import { endpoint, MiniError, type LocalModel } from "./local.js";

const instanceSchema = z.object({
  id: z.string().min(1),
  config: z.object({ context_length: z.number().int().positive() }).passthrough(),
}).passthrough();
const modelSchema = z.object({
  key: z.string().min(1),
  type: z.string(),
  max_context_length: z.number().int().positive().optional(),
  capabilities: z.object({
    trained_for_tool_use: z.boolean().optional(),
    vision: z.boolean().optional(),
  }).passthrough().optional(),
  loaded_instances: z.array(instanceSchema),
}).passthrough();
const catalogSchema = z.object({ models: z.array(modelSchema) });
type NativeModel = z.infer<typeof modelSchema>;

export type DownloadedModel = {
  key: string;
  max_context_length?: number;
  capabilities: { trained_for_tool_use: boolean; vision: boolean };
  loaded_instances: { id: string; context_length: number }[];
};

function nativeEndpoint(baseUrl: string, path: string): URL {
  const url = endpoint(baseUrl); // Preserve the existing origin/credential validation.
  url.pathname = path;
  return url;
}

async function request(url: URL, options: RequestInit, signal?: AbortSignal, timeoutMs = 5000): Promise<Response> {
  if (signal?.aborted) throw new MiniError("cancelled", "LM Studio operation cancelled");
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...options, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (error) {
    if (signal?.aborted) throw new MiniError("cancelled", "LM Studio operation cancelled");
    const code = url.pathname.endsWith("/models/load") && timeout.aborted ? "load_error" : "server_unreachable";
    throw new MiniError(code, `LM Studio request failed at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function catalog(baseUrl: string, signal?: AbortSignal): Promise<NativeModel[]> {
  const response = await request(nativeEndpoint(baseUrl, "/api/v1/models"), {}, signal);
  if (!response.ok) throw new MiniError("endpoint", `LM Studio model listing returned HTTP ${response.status}`);
  let json: unknown;
  try { json = await response.json(); }
  catch {
    if (signal?.aborted) throw new MiniError("cancelled", "LM Studio operation cancelled");
    throw new MiniError("endpoint", "Malformed LM Studio model listing");
  }
  if (signal?.aborted) throw new MiniError("cancelled", "LM Studio operation cancelled");
  const parsed = catalogSchema.safeParse(json);
  if (!parsed.success) throw new MiniError("endpoint", "Malformed LM Studio model listing");
  return parsed.data.models;
}

function eligible(model: NativeModel): boolean {
  return model.type === "llm" && model.capabilities?.trained_for_tool_use === true;
}

export async function listDownloadedModels(baseUrl: string, signal?: AbortSignal): Promise<DownloadedModel[]> {
  return (await catalog(baseUrl, signal)).filter(eligible).map(model => ({
    key: model.key,
    ...(model.max_context_length === undefined ? {} : { max_context_length: model.max_context_length }),
    capabilities: { trained_for_tool_use: true, vision: model.capabilities?.vision === true },
    loaded_instances: model.loaded_instances.map(instance => ({ id: instance.id, context_length: instance.config.context_length })),
  }));
}

function selectedInstance(model: NativeModel, id: string): LocalModel {
  const instance = model.loaded_instances.find(item => item.id === id);
  if (!instance) throw new MiniError("load_error", `LM Studio did not report loaded instance ${id} for ${model.key}`);
  return {
    id: instance.id, state: "loaded", type: model.capabilities?.vision ? "vlm" : "llm",
    loaded_context_length: instance.config.context_length, capabilities: ["tool_use"],
  };
}

/** Never unload or replace an unrelated user instance; inspect effective context after loading. */
export async function loadModel(baseUrl: string, key: string, signal?: AbortSignal): Promise<LocalModel> {
  const models = await catalog(baseUrl, signal);
  if (models.length === 0) throw new MiniError("no_downloaded_model", "No models downloaded in LM Studio");
  const model = models.find(item => item.key === key);
  if (!model) throw new MiniError("model_unavailable", `Model ${key} is not downloaded in LM Studio`);
  if (!eligible(model)) throw new MiniError("unsupported_model", `Model ${key} is not a tool-capable language model`);
  const existing = model.loaded_instances[0];
  if (existing) return selectedInstance(model, existing.id);

  const response = await request(nativeEndpoint(baseUrl, "/api/v1/models/load"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: key, echo_load_config: true }),
  }, signal, 120000);
  if (!response.ok) throw new MiniError("load_error", `LM Studio model load returned HTTP ${response.status}`);
  let json: unknown;
  try { json = await response.json(); }
  catch {
    if (signal?.aborted) throw new MiniError("cancelled", "LM Studio operation cancelled");
    throw new MiniError("load_error", "Malformed LM Studio load response");
  }
  const parsed = z.object({ instance_id: z.string().min(1) }).safeParse(json);
  if (!parsed.success) throw new MiniError("load_error", "LM Studio load response has no instance_id");
  if (signal?.aborted) throw new MiniError("cancelled", "LM Studio operation cancelled");
  const refreshed = (await catalog(baseUrl, signal)).find(item => item.key === key);
  if (!refreshed) throw new MiniError("load_error", `LM Studio did not report loaded model ${key}`);
  return selectedInstance(refreshed, parsed.data.instance_id);
}
