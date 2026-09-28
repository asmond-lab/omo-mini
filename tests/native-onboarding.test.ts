import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("Native onboarding flag suppresses automatic turns while explicit Native onboarding remains available", async () => {
  const url = pathToFileURL(resolve(import.meta.dir, "../node_modules/omo-ai/plugin/extensions/omo.js")).href;
  const plugin: { omoSenpiComponents: Array<{ name: string; register: (api: unknown, context: unknown) => Promise<void> | void }> } = await import(url);
  const onboarding = plugin.omoSenpiComponents.find(item => item.name === "onboarding");
  expect(onboarding).toBeDefined();
  const sent: Array<{ message: { customType?: string }; delivery: { triggerTurn?: boolean } }> = [];
  let onStart: ((event: { reason: string }, context: { hasUI: boolean; ui: object }) => void) | undefined;
  let disabled = true, forced = false;
  const api = {
    registerFlag: () => {},
    getFlag: (flag: string) => flag === "omo-senpi-onboarding-disabled" ? disabled : flag === "onboard" ? forced : false,
    on: (event: string, handler: typeof onStart) => { if (event === "session_start") onStart = handler; },
    sendMessage: (message: { customType?: string }, delivery: { triggerTurn?: boolean }) => { sent.push({ message, delivery }); },
    appendEntry: () => {},
  };
  await onboarding!.register(api, {});
  expect(onStart).toBeDefined();
  const startup = () => onStart!({ reason: "startup" }, { hasUI: true, ui: {} });
  startup();
  expect(sent).toHaveLength(0);
  forced = true;
  startup(); // Native's disable flag also suppresses forced onboarding if both are passed.
  expect(sent).toHaveLength(0);
  disabled = false; // Direct Native --onboard still works; Mini users can call /skill:onboarding.
  startup();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.message.customType).toBe("omo-onboarding:bootstrap");
  expect(sent[0]?.delivery.triggerTurn).toBe(true);
  startup();
  expect(sent).toHaveLength(1);
});

test("Mini exposes the bundled onboarding skill while ordinary loaded startup has no automatic inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-onboard-"));
  const state = join(root, "state");
  const wire: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [{ key: "onboard-local", type: "llm", max_context_length: 131072,
      capabilities: { trained_for_tool_use: true, vision: false }, loaded_instances: [{ id: "onboard-local", config: { context_length: 65536 } }] }] });
    if (path === "/api/v0/models") return Response.json({ data: [{ id: "onboard-local", state: "loaded", type: "llm", loaded_context_length: 65536, capabilities: ["tool_use"] }] });
    if (path !== "/v1/chat/completions") return new Response("unexpected", { status: 404 });
    wire.push(await request.json());
    return new Response(`data: ${JSON.stringify({ id: "onboard", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ACK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "onboard", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`],
    { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let id = 0, buffer = "", stderr = "";
  type Frame = { type: string; id?: string; success?: boolean; data?: Record<string, unknown>; messages?: Array<{ role: string; stopReason?: string }> };
  const listeners = new Set<(frame: Frame) => void>();
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      for (const listener of listeners) listener(frame);
    }
  });
  const wait = (match: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
    const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timer); listeners.delete(listener); child.off("exit", exited); accept(frame); } };
    const exited = () => { clearTimeout(timer); listeners.delete(listener); reject(Error(`RPC exited: ${stderr.slice(-1000)}`)); };
    const timer = setTimeout(() => { listeners.delete(listener); child.off("exit", exited); reject(Error(`RPC timeout: ${stderr.slice(-1000)}`)); }, 45000);
    listeners.add(listener); child.once("exit", exited);
  });
  const send = async (type: string, rest: Record<string, unknown> = {}) => {
    const next = String(++id), result = wait(frame => frame.type === "response" && frame.id === next);
    child.stdin!.write(JSON.stringify({ type, id: next, ...rest }) + "\n");
    const frame = await result;
    expect(frame.success, JSON.stringify(frame)).toBe(true);
    return frame;
  };
  try {
    const commands = (await send("get_commands")).data?.["commands"] as Array<{ name: string; source: string }>;
    expect(commands.some(command => command.name === "skill:onboarding" && command.source === "skill")).toBe(true);
    expect(wire).toHaveLength(0);
    const end = wait(frame => frame.type === "agent_end");
    await send("prompt", { message: "/skill:onboarding" });
    const terminal = await end;
    expect(terminal.messages?.filter(message => message.role === "assistant").at(-1)?.stopReason).toBe("stop");
    expect(wire.length).toBeGreaterThan(0);
    const invocation = (wire[0] as { messages: Array<{ role: string; content?: Array<{ type: string; text?: string }> }> })
      .messages.filter(message => message.role === "user").at(-1)?.content?.find(part => part.type === "text")?.text ?? "";
    expect(invocation).toContain('<skill-instruction name="onboarding" location="');
    expect(invocation.replaceAll("\\", "/")).toContain('/skills/onboarding/SKILL.md">');
  } finally {
    const exit = child.exitCode !== null ? Promise.resolve() : new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error("RPC exit timeout")); }, 10000);
      child.once("exit", () => { clearTimeout(timer); accept(); });
    });
    child.stdin!.end(); await exit;
    server.stop(true); await rm(root, { recursive: true, force: true });
  }
}, 120000);
