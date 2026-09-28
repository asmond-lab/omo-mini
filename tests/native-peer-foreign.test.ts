import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ensureHost, probeHost, RpcClient, SessionManager, stopHost } from "@code-yeongyu/senpi";
import { z } from "zod";

type Frame = { type: string; id?: string; success?: boolean; toolCallId?: string; result?: unknown; method?: string };
type Chat = { model?: string; messages?: Array<{ role?: string; content?: unknown }> };
const toolResult = z.object({ details: z.object({ result: z.object({ kind: z.string() }).passthrough() }).passthrough() }).passthrough();
const hostSettings = z.object({ socket: z.string(), instanceId: z.string() }).passthrough();
const textParts = z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough());
const lastUserText = (body: Chat) => {
  const parsed = textParts.safeParse(body.messages?.filter(message => message.role === "user").at(-1)?.content);
  return parsed.success && parsed.data.length === 1 ? parsed.data[0]?.text : undefined;
};

async function treeDigest(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
  return Object.fromEntries(await Promise.all(files.map(async file =>
    [relative(dir, file), createHash("sha256").update(await readFile(file)).digest("hex")] as const)));
}

// The fixture home plays the user's real home: a live OmO Native host on its global socket and a
// durable Native session under its ~/.omo. Mini runs with that HOME and must never reach either.
test("Mini peer tools never list, address or fork the user's live OmO Native host or sessions", async () => {
  const base = await mkdtemp(join(tmpdir(), "mini-peer-foreign-"));
  const home = join(base, "home"), root = join(home, "ws"), state = join(home, "mini-state"), temp = join(base, "temp");
  const nativeAgent = join(home, ".omo", "agent"), nativeSessions = join(home, ".omo", "sessions");
  const foreignSocket = join(nativeAgent, "rpc", "rpc.sock");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(join(nativeAgent, "rpc"), { recursive: true }),
    mkdir(nativeSessions, { recursive: true }), mkdir(temp)]);
  const traffic: Chat[] = [];
  let foreignLiveId = "", foreignDiskId = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [{ key: "alpha", type: "llm",
      capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "alpha-instance", config: { context_length: 65536 } }] }] });
    if (path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = await request.json() as Chat; traffic.push(body);
    const all = JSON.stringify(body.messages), last = lastUserText(body);
    const step = (marker: string, id: string) => last === marker && !all.includes(id);
    const tool = (id: string, name: string, args: object) => ({ tool_calls: [{ index: 0, id, type: "function",
      function: { name, arguments: JSON.stringify(args) } }] });
    const delta = step("CREATE-OWN-700", "create-own") ? tool("create-own", "thread_create", { name: "mini-own" })
      : step("LIST-ALL-700", "list-all") ? tool("list-all", "thread_list", { all_scope: true })
      : step("SEND-FOREIGN-700", "send-foreign") ? tool("send-foreign", "thread_send",
        { thread: foreignLiveId, message: "FOREIGN-LEAK-700", delivery: "follow_up", all_scope: true })
      : step("FORK-FOREIGN-700", "fork-foreign") ? tool("fork-foreign", "thread_create", { name: "stolen", fork_from: foreignDiskId })
      : step("FORK-LIVE-700", "fork-live") ? tool("fork-live", "thread_create", { name: "stolen-live", fork_from: foreignLiveId })
      : { content: "ACK-700" };
    const calls = "tool_calls" in delta;
    return new Response(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });

  // Foreign Native: live host on the global socket path plus a flushed durable session.
  await writeFile(join(nativeAgent, "models.json"), JSON.stringify({ providers: { foreign: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "none",
    models: [{ id: "foreign-model", name: "foreign-model", contextWindow: 65536, maxTokens: 4096, input: ["text"], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await ensureHost({ socket: foreignSocket, agentDir: nativeAgent, upgrade: "never",
    hostArgs: ["--offline", "--session-runtime", "in-process", "--session-dir", nativeSessions],
    env: { HOME: home, USERPROFILE: home, OMO_CODING_AGENT_DIR: nativeAgent, OMO_MINI_LOCAL_PROFILE: null, OMO_RPC_SOCKET: null } });
  const foreignInfo = await probeHost({ socket: foreignSocket });
  expect(foreignInfo?.instanceId).toBeTruthy();
  const foreign = new RpcClient({ socketPath: foreignSocket });
  await foreign.start();
  const opened = await foreign.openSession({ cwd: root, provider: "foreign", modelId: "foreign-model", retain_on_disconnect: true });
  await foreign.requestSession({ type: "set_session_name", name: "foreign-native-secret" }, opened.sessionId);
  const foreignListed = (await foreign.listSessions()).find(peer => peer.sessionId === opened.sessionId);
  foreignLiveId = foreignListed?.durableSessionId ?? "";
  expect(foreignLiveId).toBeTruthy();
  await foreign.stop();
  const disk = SessionManager.create(root, nativeSessions);
  disk.appendMessage({ role: "user", content: "FOREIGN-DISK-700", timestamp: Date.now() });
  disk.appendMessage({ role: "assistant", content: [{ type: "text", text: "FOREIGN-DISK-REPLY-700" }], api: "openai-completions",
    provider: "foreign", model: "foreign-model", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  foreignDiskId = disk.getSessionId();
  const sessionsBefore = await treeDigest(nativeSessions);
  expect(Object.keys(sessionsBefore).length).toBeGreaterThan(0);

  // The caller's shell points at the global host; Mini must not inherit it.
  const proc = spawn(process.execPath, [process.env["MINI_PEER_CLI"] ?? "src/cli.ts", "rpc", "--root", root, "--state-dir", state,
    "--base-url", `http://127.0.0.1:${server.port}/v1`],
  { cwd: resolve(import.meta.dir, ".."), env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp,
    OMO_RPC_SOCKET: foreignSocket, SENPI_RPC_SOCKET: foreignSocket }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const listeners = new Set<(frame: Frame) => void>(); let buffer = "", stderr = "", seq = 0;
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      if (frame.type === "extension_ui_request" && frame.method === "select" && frame.id)
        proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Allow once" }) + "\n");
      for (const listener of listeners) listener(frame);
    }
  });
  const wait = (matches: (frame: Frame) => boolean) => {
    const pending = new Promise<Frame>((accept, reject) => {
      const done = () => { clearTimeout(timer); listeners.delete(onFrame); proc.off("exit", onExit); };
      const onExit = () => { done(); reject(Error(`Mini exited: ${stderr.slice(-800)}`)); };
      const onFrame = (frame: Frame) => { if (matches(frame)) { done(); accept(frame); } };
      const timer = setTimeout(() => { done(); reject(Error(`Mini deadline: ${stderr.slice(-900)}`)); }, 75000);
      listeners.add(onFrame); proc.once("exit", onExit);
    });
    void pending.catch(() => {}); return pending;
  };
  const turn = async (marker: string, callId: string) => {
    const id = String(++seq);
    const tool = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === callId);
    const ended = wait(frame => frame.type === "agent_end");
    const answer = wait(frame => frame.type === "response" && frame.id === id);
    proc.stdin.write(JSON.stringify({ id, type: "prompt", message: marker }) + "\n");
    const [result, , accepted] = await Promise.all([tool, ended, answer]);
    expect(accepted.success).toBe(true);
    return toolResult.parse(result.result).details.result;
  };
  const miniHosts = async () => {
    const dir = join(state, "agent", "rpc-host-daemon");
    const names = await readdir(dir).catch(() => []);
    const settings = await Promise.all(names.map(name => readFile(join(dir, name, "settings.json"), "utf8").then(
      text => hostSettings.parse(JSON.parse(text)), () => undefined)));
    return settings.filter((entry): entry is z.infer<typeof hostSettings> => entry !== undefined);
  };
  let passed = false;
  try {
    const own = await turn("CREATE-OWN-700", "create-own");
    expect(own.kind).toBe("ok");
    const listed = await turn("LIST-ALL-700", "list-all");
    expect(listed.kind).toBe("ok");
    const listText = JSON.stringify(listed);
    expect(listText).toContain("mini-own");
    for (const leak of [foreignLiveId, foreignDiskId, "foreign-native-secret", foreignSocket.replaceAll("\\", "\\\\")])
      expect(listText).not.toContain(leak);
    const send = await turn("SEND-FOREIGN-700", "send-foreign");
    expect(send).toMatchObject({ kind: "error", error: { code: "not_found" } });
    expect((await turn("FORK-FOREIGN-700", "fork-foreign")).kind).toBe("error");
    expect((await turn("FORK-LIVE-700", "fork-live")).kind).toBe("error");
    // Every Mini peer host lives in Mini's own state; none is the global socket.
    const hosts = await miniHosts();
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.every(host => host.socket.startsWith(state) && host.socket !== foreignSocket)).toBe(true);
    // The foreign host is untouched: same instance, same single retained session, nothing attached.
    const after = await probeHost({ socket: foreignSocket });
    expect(after?.instanceId).toBe(foreignInfo?.instanceId);
    const observer = new RpcClient({ socketPath: foreignSocket });
    await observer.start();
    try {
      const sessions = await observer.listSessions();
      expect(sessions.map(peer => ({ id: peer.durableSessionId, attachments: peer.attachments })))
        .toEqual([{ id: foreignLiveId, attachments: 0 }]);
    } finally { await observer.stop(); }
    expect(await treeDigest(nativeSessions)).toEqual(sessionsBefore);
    // A delivered message would start a turn whose latest user text is exactly the marker; the parent's
    // tool call and Mini's memory facts pass only quote it.
    expect(traffic.some(body => lastUserText(body) === "FOREIGN-LEAK-700")).toBe(false);
    expect(traffic.every(body => body.model === "alpha-instance")).toBe(true);
    passed = true;
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const exit = new Promise<void>(accept => {
        const timer = setTimeout(() => proc.kill(), 15000);
        proc.once("exit", () => { clearTimeout(timer); accept(); });
      });
      proc.stdin.end(); await exit;
    }
    server.stop(true);
    let cleaned = true;
    for (const host of [...await miniHosts(), { socket: foreignSocket }]) {
      if (!host.socket.startsWith(base)) throw Error("Refusing to stop a host outside the owned fixture");
      if (!await probeHost({ socket: host.socket, timeoutMs: 1200 })) continue;
      const agentDir = host.socket === foreignSocket ? nativeAgent : join(state, "agent");
      const result = await stopHost({ socket: host.socket, agentDir, force: true });
      cleaned &&= result.action === "stopped" && !await probeHost({ socket: host.socket, timeoutMs: 1200 });
    }
    if (passed && cleaned) await rm(base, { recursive: true, force: true });
    else console.error(`Private foreign-host fixture retained: ${base}; cleanup=${cleaned}`);
  }
}, 150000);
