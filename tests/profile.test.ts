import { test, expect } from "bun:test";
import { join } from "node:path";
import { checkProviderRequest, identity, responseState } from "../src/policy.ts";
import { localEndpoint, modelsConfig, parseArgs, profileEnvironment, profilePaths } from "../src/profile.ts";

const model = { id: "public-local-model", state: "loaded", type: "vlm", loaded_context_length: 69376, capabilities: ["tool_use"] };

test("isolates home, agent, session and credentials when preparing a local profile", () => {
  const paths = profilePaths(join(import.meta.dir, "fixture-profile"));
  const environment = profileEnvironment({ HOME: "C:/original", USERPROFILE: "C:/original", OMO_CODING_AGENT_DIR: "C:/original/.omo/agent",
    OPENAI_API_KEY: "hidden", ANTHROPIC_AUTH_TOKEN: "hidden", GOOGLE_API_KEY: "hidden", MY_API_KEY: "hidden", PATH: "system-path" },
    paths, model, "http://127.0.0.1:1234/v1", "C:/workspace");
  expect(environment["HOME"]).toBe(paths.home);
  expect(environment["USERPROFILE"]).toBe(paths.home);
  expect(environment["OMO_CODING_AGENT_DIR"]).toBe(paths.agent);
  expect(environment["PI_CODING_AGENT_DIR"]).toBe(paths.agent);
  expect(environment["OPENAI_API_KEY"]).toBeUndefined();
  expect(environment["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  expect(environment["MY_API_KEY"]).toBeUndefined();
  expect(environment["PATH"]).toBe("system-path");
  expect(identity(environment)).toEqual({ model: model.id, baseUrl: "http://127.0.0.1:1234/v1", context: 69376, root: "C:/workspace" });
});

test("selects loaded local context, images and exact model instead of advertised maximum", () => {
  const config = modelsConfig(model, "http://localhost:1234/v1");
  expect(config.providers["omo-mini-local"].models[0]?.contextWindow).toBe(69376);
  expect(config.providers["omo-mini-local"].models[0]?.input).toEqual(["text", "image"]);
  expect(parseArgs(["run", "--task", "code"])).toMatchObject({ permission: "workspace", command: "run" });
  expect(() => localEndpoint("https://example.com/v1")).toThrow("loopback");
  expect(() => localEndpoint("http://192.168.1.5:1234/v1")).toThrow("loopback");
});

test("rejects mismatched effective provider and preserves explicit response failure states", () => {
  const allowed = { model: model.id, context: 69376, baseUrl: "http://127.0.0.1:1234/v1", root: "C:/workspace" };
  expect(() => checkProviderRequest({ provider: "fake-cloud", id: model.id, baseUrl: allowed.baseUrl, api: "openai-completions" }, {}, allowed)).toThrow("Blocked nonlocal");
  expect(() => checkProviderRequest(undefined, {}, allowed)).toThrow("Blocked nonlocal");
  expect(responseState([{ role: "assistant", stopReason: "length", content: [{ type: "text", text: "partial" }] }])).toBe("Model output reached its length limit");
  expect(responseState([{ role: "assistant", stopReason: "stop", content: [] }])).toBe("Model returned an empty answer");
  expect(responseState([], true)).toBe("Cancelled");
});
