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

/** Conservative UTF-8 byte upper-bound proxy, not an exact tokenizer. Includes schema and message framing. */
export function checkBudget(messages: readonly unknown[], contextWindow: number, outputReserve = 1536): number {
  const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8") + messages.length * 256 + 2048;
  if (bytes + outputReserve > contextWindow) throw new MiniError("context_budget", `Request bound ${bytes} bytes plus ${outputReserve} output reserve exceeds loaded context ${contextWindow}; no request sent`);
  return bytes;
}
