import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@code-yeongyu/senpi";
import { formatResumeCommand } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js";
import { MINI_IDENTITY } from "../src/local.ts";
import { parseArgs, prepareProfile, resumeHint } from "../src/profile.ts";

const saved = { profile: process.env["OMO_MINI_LOCAL_PROFILE"], hint: process.env["OMO_MINI_RESUME_HINT"], track: process.env["DO_NOT_TRACK"], tty: process.stdout.isTTY };
afterEach(() => {
  for (const [key, value] of [["OMO_MINI_LOCAL_PROFILE", saved.profile], ["OMO_MINI_RESUME_HINT", saved.hint], ["DO_NOT_TRACK", saved.track]] as const)
    value === undefined ? delete process.env[key] : process.env[key] = value;
  process.stdout.isTTY = saved.tty;
});

// A real persisted Native session: SessionManager writes the file once an assistant message exists.
function persistedSession(dir: string): SessionManager {
  const session = SessionManager.create(dir, join(dir, "sessions"));
  session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: "p", model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 2 });
  return session;
}

test("resume line is the Mini hint only under the Mini profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-resume-"));
  try {
    // Given: an interactive TTY, a persisted session file and a Mini hint in the environment
    process.stdout.isTTY = true;
    process.env["OMO_MINI_RESUME_HINT"] = "HINT-FIXTURE";
    const session = persistedSession(dir);
    // When/Then: Mini profile selects the hint; outside Mini the Native resume command is kept
    process.env["OMO_MINI_LOCAL_PROFILE"] = "1";
    expect(formatResumeCommand(session)).toBe("HINT-FIXTURE");
    delete process.env["OMO_MINI_LOCAL_PROFILE"];
    expect(formatResumeCommand(session)?.endsWith(`--session ${session.getSessionId()}`)).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Mini hint is a runnable omo-mini invocation for the same root and state", () => {
  const hint = resumeHint("C:\\work", "C:\\state");
  const [command, ...args] = hint.slice(0, hint.indexOf(",")).split(" ");
  expect(command).toBe("omo-mini");
  expect(parseArgs(args)).toMatchObject({ command: "interactive", root: "C:\\work", stateDir: "C:\\state" });
});

test("Native telemetry opt-out and identity reach the Native child environment", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ models: [{ key: "m", type: "llm",
    capabilities: { trained_for_tool_use: true, vision: false }, loaded_instances: [{ id: "m", config: { context_length: 8192 } }] }] }) });
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-env-"));
  try {
    delete process.env["DO_NOT_TRACK"];
    const args = ["--root", dir, "--state-dir", join(dir, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`];
    const off = await prepareProfile(parseArgs(args));
    expect(off.env["DO_NOT_TRACK"]).toBe("1");
    expect(off.env["OMO_MINI_IDENTITY"]).toBe(MINI_IDENTITY);
    const on = await prepareProfile(parseArgs([...args, "--native-telemetry"]));
    expect(on.env["DO_NOT_TRACK"]).toBeUndefined();
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
