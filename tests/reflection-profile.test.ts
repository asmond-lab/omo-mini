import { expect, test } from "bun:test";
import { join } from "node:path";
import { profileEnvironment, profilePaths } from "../src/profile.ts";

test("mini profile replaces an inherited memory supervisor with its local adapter", () => {
  const paths = profilePaths(join(import.meta.dir, "fixture-reflection-profile"));
  const env = profileEnvironment({ OMO_MEMORY_RUN_SUPERVISOR_PATH: "untrusted-script" }, paths,
    { id: "local-reflection", state: "loaded", loaded_context_length: 65536, capabilities: ["tool_use"] },
    "http://127.0.0.1:1234/v1", import.meta.dir);
  expect(env["OMO_MEMORY_RUN_SUPERVISOR_PATH"]).toBe(join(import.meta.dir, "..", "src", "reflection-supervisor.ts"));
});
