import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHost, probeHost, RpcClient, SessionManager, stopHost } from "@code-yeongyu/senpi";
import { z } from "zod";
import { movePeer } from "../src/peer-thread-move.ts";
import { connectPeerHost, type Host, type LivePeer } from "../src/peer-thread-rpc.ts";

type Chat = { model?: string; messages?: Array<{ role?: string; content?: unknown }> };
const state = z.object({ model: z.object({ provider: z.string(), id: z.string() }) }).passthrough();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// Real Senpi hosts, real sockets and durable transcripts; only the model HTTP wire is synthetic.
test("Mini peer move honours Native's busy contract and rolls back to exactly one original writer", async () => {
  const base = await mkdtemp(join(tmpdir(), "mini-peer-move-"));
  const home = join(base, "home"), agent = join(home, "agent"), sessions = join(home, "sessions"), ws = join(home, "ws");
  await Promise.all([mkdir(join(agent, "rpc"), { recursive: true }), mkdir(sessions, { recursive: true }), mkdir(ws, { recursive: true })]);
  const held = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Chat;
    const text = JSON.stringify(body.messages?.at(-1)?.content);
    if (text.includes("HOLD-TURN-800")) { reached.resolve(); await held.promise; }
    const delta = { content: text.includes("HOLD-TURN-800") ? "HELD-REPLY-800" : "REPLY-800" };
    return new Response(`data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { local: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "none",
    models: ["alpha", "beta"].map(id => ({ id, name: id, contextWindow: 65536, maxTokens: 4096, input: ["text"], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } }));
  const env = { HOME: home, USERPROFILE: home, OMO_CODING_AGENT_DIR: agent, SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
    OMO_MINI_LOCAL_PROFILE: null, OMO_RPC_SOCKET: null };
  const alphaSocket = join(agent, "rpc", "alpha.sock"), sockets = [alphaSocket, join(agent, "rpc", "beta.sock")];
  const hosts: Host[] = [];
  const clients: RpcClient[] = [];
  let passed = false;
  try {
    for (const socket of sockets) {
      await ensureHost({ socket, agentDir: agent, upgrade: "never", env,
        hostArgs: ["--offline", "--session-runtime", "in-process", "--session-dir", sessions] });
      hosts.push(await connectPeerHost(socket));
    }
    const [alphaHost, betaHost] = hosts as [Host, Host];
    const alpha = { provider: "local", id: "alpha" }, beta = { provider: "local", id: "beta" };
    // A durable transcript that already holds one exchange.
    const seeded = (marker: string) => {
      const manager = SessionManager.create(ws, sessions);
      manager.appendMessage({ role: "user", content: `${marker}-ASK`, timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `${marker}-ANSWER` }], api: "openai-completions",
        provider: "local", model: "alpha", stopReason: "stop", usage, timestamp: Date.now() });
      const file = manager.getSessionFile();
      if (!file) throw Error("seeded transcript has no file");
      return file;
    };
    const openPeer = async (marker: string): Promise<LivePeer> => {
      const peer = await alphaHost.openSession({ cwd: ws, provider: "local", modelId: "alpha", permissionPreset: "workspace",
        sessionPath: seeded(marker), name: marker });
      if (!peer.durableSessionId || !peer.sessionPath) throw Error("peer has no durable identity");
      return { ...peer, durableSessionId: peer.durableSessionId, sessionPath: peer.sessionPath };
    };
    const writers = async (peer: LivePeer) => (await Promise.all(hosts.map(host => host.listSessions())))
      .map(list => list.filter(item => item.durableSessionId === peer.durableSessionId).length);
    const move = (peer: LivePeer, destination: Host, commits: string[]) => movePeer({
      source: { id: peer.sessionId, host: alphaHost, model: alpha, peer }, destination: { host: destination, model: beta },
      permission: "workspace", commit: () => commits.push(peer.durableSessionId),
    });

    // 1. Mid-turn peer: Native refuses the close; the turn is not aborted and nothing moves.
    const busy = await openPeer("BUSY-801");
    await alphaHost.prompt(busy.sessionId, "HOLD-TURN-800");
    await reached.promise;
    const busyCommits: string[] = [];
    const outcome = await move(busy, betaHost, busyCommits).then(() => "moved", (error: unknown) => String(error));
    expect(outcome).toContain("session_busy");
    expect(busyCommits).toEqual([]);
    expect(await writers(busy)).toEqual([1, 0]);
    const observer = new RpcClient({ socketPath: alphaSocket });
    clients.push(observer); await observer.start();
    await observer.openSession({ sessionPath: busy.sessionPath, cwd: ws });
    const ended = new Promise<unknown>(accept => { const off = observer.onEvent(event => {
      if (event.type === "agent_end") { off(); accept(event); } }); });
    held.resolve();
    await ended;
    expect(await readFile(busy.sessionPath, "utf8")).toContain("HELD-REPLY-800");

    // 2. Idle peer with a second attachment: still refused, since another client owns it too.
    const shared = await openPeer("SHARED-802");
    const other = new RpcClient({ socketPath: alphaSocket });
    clients.push(other); await other.start();
    expect((await other.openSession({ sessionPath: shared.sessionPath, cwd: ws })).attached).toBe(true);
    await expect(move(shared, betaHost, [])).rejects.toThrow("session_busy");
    expect(await writers(shared)).toEqual([1, 0]);

    // 3. Injected failure after the destination opened: its writer closes and the original returns.
    const failing = await openPeer("FAIL-803");
    const transcript = await readFile(failing.sessionPath, "utf8");
    const broken: Host = { ...betaHost, setModel: () => Promise.reject(Error("INJECTED-SET-MODEL-803")) };
    const failCommits: string[] = [];
    await expect(move(failing, broken, failCommits)).rejects.toThrow("INJECTED-SET-MODEL-803");
    expect(failCommits).toEqual([]);
    expect(await writers(failing)).toEqual([1, 0]);
    const restored = (await alphaHost.listSessions()).find(item => item.durableSessionId === failing.durableSessionId);
    expect(restored?.sessionPath).toBe(failing.sessionPath);
    expect(state.parse(await alphaHost.getState(restored?.sessionId ?? "")).model).toMatchObject(alpha);
    expect(await readFile(failing.sessionPath, "utf8")).toStartWith(transcript);

    // 4. Idle, sole attachment: the move commits and the source writer is gone.
    const idle = await openPeer("MOVE-804");
    const commits: string[] = [];
    const moved = await move(idle, betaHost, commits);
    expect(commits).toEqual([idle.durableSessionId]);
    expect(await writers(idle)).toEqual([0, 1]);
    expect(state.parse(await betaHost.getState(moved.sessionId)).model).toMatchObject(beta);
    expect(await readFile(idle.sessionPath, "utf8")).toContain("MOVE-804-ANSWER");
    passed = true;
  } finally {
    held.resolve();
    for (const client of clients) await client.stop();
    for (const host of hosts) await host.release();
    server.stop(true);
    let cleaned = true;
    for (const socket of sockets) {
      if (!await probeHost({ socket, timeoutMs: 1200 })) continue;
      const result = await stopHost({ socket, agentDir: agent, force: true });
      cleaned &&= result.action === "stopped" && !await probeHost({ socket, timeoutMs: 1200 });
    }
    if (passed && cleaned) await rm(base, { recursive: true, force: true });
    else console.error(`Private peer move fixture retained: ${base}; cleanup=${cleaned}`);
  }
}, 120000);
