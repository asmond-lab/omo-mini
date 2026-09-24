import { z } from "zod";
import type { Model } from "@earendil-works/pi-ai";

export class MiniError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "MiniError"; }
}

const listing = z.object({ data: z.array(z.object({
  id: z.string().min(1), state: z.string(), type: z.string().optional(),
  loaded_context_length: z.number().int().positive().optional(),
  capabilities: z.array(z.string()).optional(),
})) });
export type LocalModel = z.infer<typeof listing>["data"][number];

export function chooseModel(models: readonly LocalModel[], requested?: string): LocalModel {
  const eligible = models.filter(m => m.state === "loaded" && m.capabilities?.includes("tool_use") && m.loaded_context_length);
  if (requested) {
    const match = eligible.find(m => m.id === requested);
    if (!match) throw new MiniError("model_unavailable", `Model ${requested} is not loaded and tool-capable`);
    return match;
  }
  if (eligible.length !== 1) throw new MiniError("model_selection", `Expected exactly one loaded tool-capable model, found ${eligible.length}; use --model`);
  const selected = eligible[0];
  if (!selected) throw new MiniError("model_selection", "No loaded tool-capable model");
  return selected;
}

export function endpoint(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || !/^\/(?:v1)?\/?$/.test(url.pathname)) {
    throw new MiniError("base_url", "--base-url must be an HTTP(S) origin, optionally ending in /v1, without credentials");
  }
  url.pathname = "/api/v0/models";
  return url;
}

export async function discover(baseUrl: string, requested?: string, signal?: AbortSignal): Promise<LocalModel> {
  const url = endpoint(baseUrl);
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(5000) });
  if (!response.ok) throw new MiniError("endpoint", `Model listing returned HTTP ${response.status}`);
  const body = listing.safeParse(await response.json());
  if (!body.success) throw new MiniError("endpoint", "Malformed model listing");
  return chooseModel(body.data.data, requested);
}

export function sdkModel(selected: LocalModel, baseUrl: string): Model<"openai-completions"> {
  const context = selected.loaded_context_length;
  if (!context) throw new MiniError("model_unavailable", "Loaded context missing");
  return {
    id: selected.id, name: selected.id, api: "openai-completions", provider: "local",
    baseUrl: new URL("/v1", baseUrl).href, reasoning: false, input: selected.type === "vlm" ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: context, maxTokens: Math.min(1024, Math.max(1, context - 2048)),
  };
}

/** Conservative text-byte proxy plus a tile-based image-token estimate, not exact provider tokenization. */
export function checkBudget(request: unknown, contextWindow: number, outputReserve = 1536): number {
  let imageCost = 0;
  const serialized = JSON.stringify(request, (key, value: unknown) => {
    if (key === "data" && typeof value === "string" && value.length > 32 && value.startsWith("iVBORw0KGgo")) {
      const header = Buffer.from(value.slice(0, 32), "base64");
      const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
      // VLM patch costs depend on the provider; 1024 per 512px tile is a conservative estimate.
      imageCost += Math.ceil(width / 512) * Math.ceil(height / 512) * 1024;
      return "[image payload]";
    }
    return value;
  });
  const bytes = Buffer.byteLength(serialized, "utf8") + 2048 + imageCost;
  if (bytes + outputReserve > contextWindow) throw new MiniError("context_budget", `Request bound ${bytes} text-byte/image-estimate units plus ${outputReserve} output reserve exceeds loaded context ${contextWindow}; no request sent`);
  return bytes;
}
