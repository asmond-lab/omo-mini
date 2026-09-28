import { test, expect } from "bun:test";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { formatSkillsForPrompt } from "@code-yeongyu/senpi";
import { checkProviderRequest, compactPrompt, identity, responseState, TurnBudget, MAX_TOOL_ERRORS } from "../src/policy.ts";
import { localEndpoint, modelsConfig, parseArgs, profileEnvironment, profilePaths } from "../src/profile.ts";
import { nativeTelemetryFlags } from "../src/cli.ts";

const model = { id: "public-local-model", state: "loaded", type: "vlm", loaded_context_length: 69376, capabilities: ["tool_use"] };

test("isolates home, agent, session and credentials when preparing a local profile", () => {
  const paths = profilePaths(join(import.meta.dir, "fixture-profile"));
  const environment = profileEnvironment({ HOME: "C:/original", USERPROFILE: "C:/original", OMO_CODING_AGENT_DIR: "C:/original/.omo/agent",
    OPENAI_API_KEY: "hidden", ANTHROPIC_AUTH_TOKEN: "hidden", GOOGLE_API_KEY: "hidden", MY_API_KEY: "hidden",
    CONTEXT7_API_KEY: "docs-only", GREP_APP_API_KEY: "search-only", PATH: "system-path" },
    paths, model, "http://127.0.0.1:1234/v1", "C:/workspace");
  expect(environment["HOME"]).toBe(paths.home);
  expect(environment["USERPROFILE"]).toBe(paths.home);
  expect(environment["OMO_CODING_AGENT_DIR"]).toBe(paths.agent);
  expect(environment["PI_CODING_AGENT_DIR"]).toBe(paths.agent);
  expect(environment["OPENAI_API_KEY"]).toBeUndefined();
  expect(environment["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  expect(environment["MY_API_KEY"]).toBeUndefined();
  expect(environment["CONTEXT7_API_KEY"]).toBe("docs-only");
  expect(environment["GREP_APP_API_KEY"]).toBe("search-only");
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

test("scales profile output limit with the loaded context", () => {
  for (const [context, expectedMaxTokens] of [[2048, 1], [3072, 1], [8192, 2048], [32768, 8192], [69376, 8192]] as const) {
    const config = modelsConfig({ ...model, loaded_context_length: context }, "http://localhost:1234/v1");
    expect(config.providers["omo-mini-local"].models[0]?.maxTokens).toBe(expectedMaxTokens);
  }
});

test("rejects JSON mode for RPC", () => {
  expect(() => parseArgs(["rpc", "--json"])).toThrow("--json requires run or doctor");
});

test("Native telemetry is disabled by default and explicitly opt-in only for agent sessions", () => {
  expect(parseArgs(["rpc"]).nativeTelemetry).toBe(false);
  expect(nativeTelemetryFlags(parseArgs(["rpc"]).nativeTelemetry)).toEqual(["--omo-senpi-telemetry-disabled"]);
  expect(parseArgs(["rpc", "--native-telemetry"]).nativeTelemetry).toBe(true);
  expect(nativeTelemetryFlags(parseArgs(["rpc", "--native-telemetry"]).nativeTelemetry)).toEqual([]);
  expect(() => parseArgs(["rpc", "--native-telemetry", "--native-telemetry"])).toThrow("Duplicate --native-telemetry");
  expect(() => parseArgs(["doctor", "--native-telemetry"])).toThrow("--native-telemetry requires an agent session");
});

test("compact prompt retains structured project instructions and native tool visibility", () => {
  const prompt = compactPrompt({ cwd: "C:/workspace", selectedTools: ["read", "bash", "edit", "write"],
    toolSnippets: { read: "read files", edit: "edit files" }, contextFiles: [{ path: "AGENTS.md", content: "PROJECT-RULE-417" }],
    appendSystemPrompt: "LOCAL-APPEND-419" }, { model: model.id, context: 69376, baseUrl: "http://127.0.0.1:1234/v1", root: "C:/workspace" });
  for (const text of ["PROJECT-RULE-417", "LOCAL-APPEND-419", "read", "bash", "edit", "write", model.id, "C:/workspace"]) expect(prompt).toContain(text);
  expect(prompt).not.toContain("Pi documentation");
  const examples = [...prompt.matchAll(/<eval_arguments>(\{[^<\n]+\})<\/eval_arguments>/g)]
    .map(match => JSON.parse(match[1]!) as Record<string, unknown>);
  expect(examples.length).toBeGreaterThan(0);
  for (const example of examples) {
    expect(Object.keys(example).sort()).toEqual(["code", "language", "summary"]);
    expect(example["language"]).toBe("js");
    expect(typeof example["code"] === "string" && example["code"].trim().length > 0).toBe(true);
    expect(typeof example["summary"] === "string" && example["summary"].trim().length > 0).toBe(true);
  }
  expect(examples.some(example => typeof example["code"] === "string" && example["code"].includes("tool.bash("))).toBe(true);
});

test("provider requests are not capped while consecutive tool errors still stop the turn", () => {
  const budget = new TurnBudget();
  for (let index = 0; index < 100; index++) expect(budget.admission()).toBeUndefined();
  for (let index = 1; index < MAX_TOOL_ERRORS; index++) {
    budget.toolResult(true);
    expect(budget.admission()).toBeUndefined();
  }
  budget.toolResult(true);
  expect(budget.admission()).toContain("consecutive tool errors; answer not completed");
  expect(budget.admission()).toContain("consecutive tool errors; answer not completed");
  budget.toolResult(false);
  expect(budget.admission()).toBeUndefined();
  for (let index = 0; index < MAX_TOOL_ERRORS; index++) budget.toolResult(true);
  expect(budget.admission()).toContain("tool errors");
  budget.reset();
  expect(budget.admission()).toBeUndefined();
});

test("compact prompt exposes all native-discovered callable skills, including bundled skills", () => {
  const memoryHome = "C:/mini-state/memory";
  const agent = "current-agent";
  const skill = (name: string, filePath: string, disableModelInvocation = false) => ({
    name, description: `Use ${name} for a fixture task`, filePath, baseDir: dirname(filePath),
    sourceInfo: { path: filePath, source: "test", scope: "system" as const, origin: "top-level" as const }, disableModelInvocation,
  });
  const prompt = compactPrompt({ cwd: "C:/workspace", memoryHome, skills: [
    skill("windows-ps-script", `${memoryHome}/agents/${agent}/repo/skills/windows-ps-script/SKILL.md`),
    skill("private-command", `${memoryHome}/agents/${agent}/repo/skills/private-command/SKILL.md`, true),
    skill("other-identity", `${memoryHome}/agents/other-agent/repo/skills/other-identity/SKILL.md`),
    skill("global-bundled", "C:/global/skills/global-bundled/SKILL.md"),
  ] }, { model: model.id, context: 69376, baseUrl: "http://127.0.0.1:1234/v1", root: "C:/workspace" },
  `<!-- senpi-memory:${agent}:begin -->\nNative memory\n<!-- senpi-memory:${agent}:end -->`);
  expect(prompt).toContain("<available_skills>");
  expect(prompt).toContain("<name>windows-ps-script</name>");
  expect(prompt).toContain("<description>Use windows-ps-script for a fixture task</description>");
  expect(prompt).toContain(`<r0>${memoryHome}/agents/${agent}/repo/skills</r0>`);
  expect(prompt).toContain("<location>r0/windows-ps-script/SKILL.md</location>");
  expect(prompt).toContain("<name>other-identity</name>");
  expect(prompt).toContain("<name>global-bundled</name>");
  expect(prompt).not.toContain("<name>private-command</name>");
});

test("native memory projection survives local prompt compaction above four kilobytes", () => {
  const contents = JSON.stringify({ observed: Array.from({ length: 400 }, (_, index) => `tool-result-${index}`) });
  const block = `<!-- senpi-memory:project:begin -->\n<memory><self-aware>${contents}</self-aware></memory>\n<!-- senpi-memory:project:end -->`;
  expect(Buffer.byteLength(block)).toBeGreaterThan(4096);
  const prompt = compactPrompt({ cwd: "C:/workspace" }, { model: model.id, context: 65536, baseUrl: "http://127.0.0.1:1234/v1", root: "C:/workspace" }, block);
  const projected = prompt.match(/<self-aware>([\s\S]*?)<\/self-aware>/)?.[1];
  expect(projected && JSON.parse(projected)).toEqual(JSON.parse(contents));
});

test("native and committed memory skills share one catalog with uniquely resolving root aliases", async () => {
  const state = await mkdtemp(join(tmpdir(), "omo-mini-skill-roots-"));
  try {
    const memoryHome = join(state, "memory"), agent = "project-64281", skillName = "observed-memory";
    const memoryFile = join(memoryHome, "agents", agent, "repo", "skills", skillName, "SKILL.md");
    await mkdir(dirname(memoryFile), { recursive: true });
    await writeFile(memoryFile, `---\nname: ${skillName}\ndescription: Use observed memory instructions\n---\n\nRead the committed instructions.\n`);
    const native = [
      { name: "native-global", path: join(state, "bundled", "skills", "native-global", "SKILL.md") },
      { name: "native-project", path: join(state, "project", ".omo", "skills", "native-project", "SKILL.md") },
    ].map(({ name, path }) => ({ name, description: `Use ${name}`, filePath: path, baseDir: dirname(path), disableModelInvocation: false,
      sourceInfo: { path, source: "test", scope: "system" as const, origin: "top-level" as const } }));
    for (const skill of native) {
      await mkdir(dirname(skill.filePath), { recursive: true });
      await writeFile(skill.filePath, `---\nname: ${skill.name}\ndescription: Fixture\n---\n`);
    }
    const normalized = native.map(skill => ({ ...skill, filePath: skill.filePath.replaceAll("\\", "/") }));
    const incoming = `NATIVE-SYSTEM-SENTINEL\n${formatSkillsForPrompt(normalized)}\n<!-- senpi-memory:${agent}:begin -->\nMemory projection\n<!-- senpi-memory:${agent}:end -->\nEXTENSION-SENTINEL`;
    const prompt = compactPrompt({ cwd: state, memoryHome, skills: native },
      { model: model.id, context: 69376, baseUrl: "http://127.0.0.1:1234/v1", root: state }, incoming);
    expect(prompt).toContain("NATIVE-SYSTEM-SENTINEL");
    expect(prompt).toContain("EXTENSION-SENTINEL");
    expect(JSON.parse(prompt.match(/<eval_arguments>(\{[^<\n]+\})<\/eval_arguments>/)?.[1] ?? "null")).toMatchObject({ language: "js" });
    expect(prompt.match(/<skill_roots>/g)).toHaveLength(1);
    expect(prompt.match(/<available_skills>/g)).toHaveLength(1);
    const roots = [...prompt.matchAll(/<r(\d+)>([^<]+)<\/r\1>/g)].map(match => [match[1], match[2]] as const);
    expect(new Set(roots.map(([alias]) => alias)).size).toBe(roots.length);
    const rootByAlias = new Map(roots);
    const items = [...prompt.matchAll(/<skill>\s*<name>([^<]+)<\/name>[\s\S]*?<location>r(\d+)\/([^<]+)<\/location>\s*<\/skill>/g)];
    const expected = new Map<string, string>([...native.map(skill => [skill.name, skill.filePath.replaceAll("\\", "/")] as const),
      [skillName, memoryFile.replaceAll("\\", "/")] as const]);
    expect(items.map(item => item[1])).toEqual([...expected.keys()]);
    for (const item of items) {
      const root = rootByAlias.get(item[2]!);
      expect(root).toBeDefined();
      const file = expected.get(item[1]!);
      expect(file).toBeDefined();
      expect(`${root}/${item[3]}`).toBe(file!);
      const contents = await readFile(join(root!, item[3]!), "utf8");
      expect(/^name: (.+)$/m.exec(contents)?.[1]).toBe(item[1]);
    }
  } finally { await rm(state, { recursive: true, force: true }); }
});

test("native memory paths resolve Korean identities only inside the mini memory home", () => {
  const memoryHome = join(import.meta.dir, "mini-state", "memory");
  const allowed = { model: model.id, context: 65536, baseUrl: "http://127.0.0.1:1234/v1", root: "C:/workspace" };
  for (const agent of ["project-a12b34cd", "한글-프로젝트-a12b34cd"]) {
    const block = `<!-- senpi-memory:${agent}:begin -->\n<projection>$MEMORY_DIR/system/human.md</projection>\n<!-- senpi-memory:${agent}:end -->`;
    const prompt = compactPrompt({ cwd: allowed.root, memoryHome }, allowed, block);
    expect(prompt).toContain(join(memoryHome, "agents", agent, "repo"));
    expect(prompt).not.toContain("$MEMORY_DIR");
  }
  for (const agent of ["../outside", "..\\outside", "C:\\outside"]) {
    const block = `<!-- senpi-memory:${agent}:begin -->\n$MEMORY_DIR/system/human.md\n<!-- senpi-memory:${agent}:end -->`;
    expect(compactPrompt({ cwd: allowed.root, memoryHome }, allowed, block)).not.toContain("system/human.md");
  }
});

test("rejects mismatched effective provider and preserves explicit response failure states", () => {
  const allowed = { model: model.id, context: 69376, baseUrl: "http://127.0.0.1:1234/v1", root: "C:/workspace" };
  const local = { provider: "omo-mini-local", id: model.id, baseUrl: allowed.baseUrl, api: "openai-completions" };
  expect(() => checkProviderRequest(local, allowed)).not.toThrow();
  for (const mismatch of [{ provider: "fake-cloud" }, { id: "wrong-model" }, { baseUrl: "http://127.0.0.1:9999/v1" }, { api: "openai-responses" }])
    expect(() => checkProviderRequest({ ...local, ...mismatch }, allowed)).toThrow("Blocked nonlocal");
  expect(() => checkProviderRequest(undefined, allowed)).toThrow("Blocked nonlocal");
  expect(responseState([{ role: "assistant", stopReason: "length", content: [{ type: "text", text: "partial" }] }])).toBe("Model output reached its length limit");
  expect(responseState([{ role: "assistant", stopReason: "stop", content: [] }])).toBe("Model returned an empty answer");
  expect(responseState([], true)).toBe("Cancelled");
});
