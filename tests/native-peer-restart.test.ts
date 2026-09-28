import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient, SessionManager, probeHost, stopHost } from "@code-yeongyu/senpi";
import { z } from "zod";

type Frame = { type: string; id?: string; success?: boolean; toolCallId?: string; result?: unknown;
  method?: string; title?: string; data?: unknown };
type Chat = { model?: string; messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }> };
const nativeResult = z.object({ details: z.object({ result: z.object({ kind: z.string(),
  thread: z.object({ thread_id: z.string(), sessionPath: z.string(), cwd: z.string() }).optional(),
  model: z.object({ provider: z.string(), id: z.string() }).optional(),
}).passthrough() }).passthrough() }).passthrough();
const hostSettings = z.object({ socket: z.string(), instanceId: z.string() }).passthrough();
const textParts = z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough());
function lastUserText(body: Chat): string | undefined {
  const latest = body.messages?.filter(message => message.role === "user").at(-1);
  const parsed = textParts.safeParse(latest?.content);
  return parsed.success && parsed.data.length === 1 ? parsed.data[0]?.text : undefined;
}

test("Native Mini peer hosts retain independent guards, resume after caller restart, move a local peer and fork dormant history", async () => {
  const base = await mkdtemp(join(tmpdir(), "mini-peer-restart-"));
  // Hermetic: the fixture home is the Native home boundary, so no config walk reaches a real home.
  const home = join(base, "home"), root = join(home, "work"), other = join(home, "other"), hostile = join(home, "hostile");
  const state = join(home, "mini-state"), temp = join(base, "temp"), startedAt = Date.now();
  await Promise.all([mkdir(root, { recursive: true }), mkdir(other, { recursive: true }), mkdir(join(hostile, ".omo"), { recursive: true }), mkdir(temp)]);
  await writeFile(join(hostile, ".omo", "omo.json"), JSON.stringify({ memory: { sync: { enabled: true } } }));
  const agent = join(state, "agent"), traffic: Chat[] = [];
  let alphaId = "", betaId = "", forkSourceId = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: ["alpha", "beta"].map(key => ({
      key, type: "llm", capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: `${key}-instance`, config: { context_length: 65536 } }],
    })) });
    if (path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = await request.json() as Chat; traffic.push(body);
    const all = JSON.stringify(body.messages);
    const last = lastUserText(body);
    const step = (marker: string, callId: string) => last === marker && !all.includes(callId);
    const tool = (id: string, name: string, args: object) => ({ tool_calls: [{ index: 0, id, type: "function",
      function: { name, arguments: JSON.stringify(args) } }] });
    const delta = step("CREATE-ALPHA-550", "create-alpha") ? tool("create-alpha", "thread_create", { name: "owned-alpha" })
      : step("CREATE-BETA-550", "create-beta") ? tool("create-beta", "thread_create", { name: "owned-beta" })
      : step("LIST-OWNED-550", "list-owned") ? tool("list-owned", "thread_list", {})
      : step("SEND-ALPHA-550", "send-alpha") ? tool("send-alpha", "thread_send", { thread: alphaId, message: "ALPHA-AFTER-SWITCH-550", delivery: "follow_up" })
      : step("SEND-BETA-550", "send-beta") ? tool("send-beta", "thread_send", { thread: betaId, message: "BETA-AFTER-RESTART-550", delivery: "follow_up" })
      : step("MOVE-BETA-550", "move-beta") ? tool("move-beta", "thread_set_model", { thread: betaId, model: "alpha-instance" })
      : step("SEND-MOVED-550", "send-moved") ? tool("send-moved", "thread_send", { thread: betaId, message: "MOVED-BETA-550", delivery: "follow_up" })
      : step("SEND-ALPHA-POSTMOVE-551", "send-alpha-postmove") ? tool("send-alpha-postmove", "thread_send", { thread: alphaId, message: "ALPHA-POSTMOVE-551", delivery: "follow_up" })
      : step("FORK-DORMANT-550", "fork-dormant") ? tool("fork-dormant", "thread_create", { name: "forked-dormant", fork_from: forkSourceId })
      : step("OTHER-CWD-550", "other-cwd") ? tool("other-cwd", "thread_create", { name: "other-workspace", cwd: other })
      : step("HOSTILE-CWD-552", "hostile-cwd") ? tool("hostile-cwd", "thread_create", { name: "hostile-workspace", cwd: hostile })
      : last === "ALPHA-AFTER-SWITCH-550" ? { content: "ALPHA-GUARD-550" }
      : last === "BETA-AFTER-RESTART-550" ? { content: "BETA-GUARD-550" }
      : last === "MOVED-BETA-550" ? { content: "MOVED-LOCAL-550" }
      : last === "ALPHA-POSTMOVE-551" ? { content: "ALPHA-STILL-551" }
      : { content: "PARENT-ACK-550" };
    const calls = "tool_calls" in delta;
    return new Response(`data: ${JSON.stringify({ id: "peer-restart", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "peer-restart", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  type Machine = { request(type: string, args?: object): Promise<Frame>;
    turn(marker: string, toolCallId: string): Promise<z.infer<typeof nativeResult>["details"]["result"]>;
    stop(): Promise<void> };
  const machines: Machine[] = [];
  function start(model?: string): Machine {
    const proc = spawn(process.execPath, [process.env["MINI_PEER_CLI"] ?? "src/cli.ts", "rpc", "--root", root, "--state-dir", state,
      "--base-url", `http://127.0.0.1:${server.port}/v1`, ...(model ? ["--model", model] : [])],
    { cwd: resolve(import.meta.dir, ".."), env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
        const onExit = () => { done(); reject(Error(`Native caller exited: ${stderr.slice(-800)}`)); };
        const onFrame = (frame: Frame) => { if (matches(frame)) { done(); accept(frame); } };
        const timer = setTimeout(() => { done(); reject(Error(`Native caller deadline: ${stderr.slice(-900)}`)); }, 75000);
        listeners.add(onFrame); proc.once("exit", onExit);
      });
      void pending.catch(() => {}); return pending;
    };
    const request = async (type: string, args: object = {}) => {
      const id = String(++seq), response = wait(frame => frame.type === "response" && frame.id === id);
      proc.stdin.write(JSON.stringify({ id, type, ...args }) + "\n");
      return response;
    };
    const turn = async (marker: string, toolCallId: string) => {
      const tool = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === toolCallId);
      const ended = wait(frame => frame.type === "agent_end");
      const answer = request("prompt", { message: marker });
      const [result, , accepted] = await Promise.all([tool, ended, answer]);
      expect(accepted.success).toBe(true);
      return nativeResult.parse(result.result).details.result;
    };
    const stop = async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exit = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { proc.kill(); reject(Error("Owned Native caller did not exit on EOF")); }, 15000);
        proc.once("exit", () => { clearTimeout(timer); accept(); });
      });
      proc.stdin.end(); await exit;
    };
    const machine = { request, turn, stop }; machines.push(machine); return machine;
  }
  async function ownedSockets() {
    const dir = join(agent, "rpc-host-daemon");
    const children = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    const settings = await Promise.all(children.filter(child => child.isDirectory()).map(async child => {
      let text: string;
      try { text = await readFile(join(dir, child.name, "settings.json"), "utf8"); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
      return hostSettings.parse(JSON.parse(text));
    }));
    return settings.filter((entry): entry is z.infer<typeof hostSettings> => entry !== undefined);
  }
  async function observePeer(durableId: string, sessionPath: string) {
    const settings = await ownedSockets();
    for (const entry of settings) {
      const client = new RpcClient({ socketPath: entry.socket });
      try {
        await client.start();
        if (!(await client.listSessions()).some(peer => peer.durableSessionId === durableId)) { await client.stop(); continue; }
        const attached = await client.openSession({ sessionPath, cwd: root });
        expect(attached.attached).toBe(true);
        return { client, settings: entry };
      } catch (error) { await client.stop(); throw error; }
    }
    throw Error(`No owned Native host holds peer ${durableId}`);
  }
  async function peerRequest(machine: Machine, marker: string, callId: string,
    id: string, path: string, expectedModel: string, answer: string) {
    const observer = await observePeer(id, path);
    try {
      const done = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { off(); reject(Error(`Peer ${id} did not finish a turn`)); }, 45000);
        const off = observer.client.onEvent(event => {
          if (event.type === "agent_end") { clearTimeout(timer); off(); accept(); }
        });
      });
      const result = machine.turn(marker, callId);
      expect((await result).kind).toBe("ok");
      await done;
      const requestMarker = answer === "ALPHA-GUARD-550" ? "ALPHA-AFTER-SWITCH-550"
        : answer === "BETA-GUARD-550" ? "BETA-AFTER-RESTART-550"
        : answer === "ALPHA-STILL-551" ? "ALPHA-POSTMOVE-551" : "MOVED-BETA-550";
      const calls = traffic.filter(body => lastUserText(body) === requestMarker);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(body => body.model === expectedModel), JSON.stringify(calls.map(body => body.model))).toBe(true);
      expect(JSON.stringify(observer.client.getStderr())).not.toContain("Blocked nonlocal provider request");
    } finally { await observer.client.stop(); }
  }
  let passed = false;
  try {
    const first = start();
    const alpha = await first.turn("CREATE-ALPHA-550", "create-alpha");
    expect(alpha.kind).toBe("ok"); expect(alpha.thread).toBeDefined();
    alphaId = alpha.thread?.thread_id ?? "";
    expect(alphaId).toBeTruthy();
    expect((await first.request("set_model", { provider: "omo-mini-local", modelId: "beta" })).success).toBe(true);
    const selected = z.object({ model: z.object({ provider: z.string(), id: z.string() }) })
      .parse((await first.request("get_state")).data);
    expect(selected.model).toMatchObject({ provider: "omo-mini-local", id: "beta-instance" });
    await first.stop(); // Re-enter after Native's asynchronous config reload, not during its old tool generation.
    const switched = start("beta");
    const beta = await switched.turn("CREATE-BETA-550", "create-beta");
    expect(beta.kind).toBe("ok"); expect(beta.thread).toBeDefined();
    betaId = beta.thread?.thread_id ?? "";
    expect(betaId).toBeTruthy();
    await peerRequest(switched, "SEND-ALPHA-550", "send-alpha", alphaId, alpha.thread?.sessionPath ?? "", "alpha-instance", "ALPHA-GUARD-550");
    await peerRequest(switched, "SEND-BETA-550", "send-beta", betaId, beta.thread?.sessionPath ?? "", "beta-instance", "BETA-GUARD-550");
    const before = await ownedSockets();
    expect(before).toHaveLength(2);
    await switched.stop();
    const second = start("beta");
    const listed = await second.turn("LIST-OWNED-550", "list-owned");
    expect(listed.kind).toBe("ok");
    const listText = JSON.stringify(listed);
    expect(listText).toContain(alphaId); expect(listText).toContain(betaId);
    // Real timestamps: Native falls back to the epoch when a host omits createdAt.
    const stamps = z.object({ threads: z.array(z.object({ thread_id: z.string(), created_at: z.string(), updated_at: z.string() }).passthrough()) })
      .passthrough().parse(listed).threads.filter(thread => thread.thread_id === alphaId || thread.thread_id === betaId);
    expect(stamps).toHaveLength(2);
    for (const stamp of stamps) {
      expect(Date.parse(stamp.created_at)).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(stamp.updated_at)).toBeGreaterThanOrEqual(Date.parse(stamp.created_at));
    }
    const after = await ownedSockets();
    expect(after.map(item => item.instanceId).sort()).toEqual(before.map(item => item.instanceId).sort());
    await peerRequest(second, "SEND-ALPHA-550", "send-alpha", alphaId, alpha.thread?.sessionPath ?? "", "alpha-instance", "ALPHA-GUARD-550");
    await peerRequest(second, "SEND-BETA-550", "send-beta", betaId, beta.thread?.sessionPath ?? "", "beta-instance", "BETA-GUARD-550");
    const moved = await second.turn("MOVE-BETA-550", "move-beta");
    expect(moved.kind).toBe("ok");
    expect(moved.model).toMatchObject({ provider: "omo-mini-local", id: "alpha-instance" });
    const parentState = z.object({ model: z.object({ provider: z.string(), id: z.string() }) })
      .parse((await second.request("get_state")).data);
    expect(parentState.model).toMatchObject({ provider: "omo-mini-local", id: "beta-instance" });
    await peerRequest(second, "SEND-MOVED-550", "send-moved", betaId, beta.thread?.sessionPath ?? "", "alpha-instance", "MOVED-LOCAL-550");
    await peerRequest(second, "SEND-ALPHA-POSTMOVE-551", "send-alpha-postmove", alphaId,
      alpha.thread?.sessionPath ?? "", "alpha-instance", "ALPHA-STILL-551");
    const outside = await second.turn("OTHER-CWD-550", "other-cwd");
    expect(outside.kind).toBe("ok");
    expect(outside.thread?.cwd).toBe(other);
    // The isolated project-config check applies at an explicit peer cwd too.
    const refused = await second.turn("HOSTILE-CWD-552", "hostile-cwd");
    expect(refused.kind).toBe("error");
    expect(JSON.stringify(refused)).toContain("isolated local policy");
    const dormant = SessionManager.forkFrom(alpha.thread?.sessionPath ?? "", root, join(state, "sessions"));
    forkSourceId = dormant.getSessionId();
    expect(forkSourceId).toBeTruthy();
    const hosts = await ownedSockets();
    const listedIds = await Promise.all(hosts.map(async entry => {
      const client = new RpcClient({ socketPath: entry.socket });
      await client.start();
      try { return (await client.listSessions()).map(peer => peer.durableSessionId); }
      finally { await client.stop(); }
    }));
    expect(listedIds.flat()).not.toContain(forkSourceId);
    const fork = await second.turn("FORK-DORMANT-550", "fork-dormant");
    expect(fork.kind).toBe("ok"); expect(fork.thread).toBeDefined();
    const content = await readFile(fork.thread?.sessionPath ?? "", "utf8");
    expect(content).toContain("ALPHA-AFTER-SWITCH-550");
    expect(content).toContain("ALPHA-GUARD-550");
    expect(fork.thread?.thread_id).not.toBe(alphaId);
    expect(traffic.every(body => body.model === "alpha-instance" || body.model === "beta-instance")).toBe(true);
    passed = true;
  } finally {
    for (const machine of machines.toReversed()) await machine.stop();
    server.stop(true);
    let cleaned = true;
    for (const host of await ownedSockets()) {
      if (!host.socket.includes(base)) throw Error("Refusing to stop host outside owned fixture");
      const live = await probeHost({ socket: host.socket, timeoutMs: 1200 });
      if (!live) continue;
      if (live.instanceId !== host.instanceId) throw Error("Owned host instance changed before cleanup");
      const result = await stopHost({ socket: host.socket, agentDir: agent, force: true });
      cleaned &&= result.action === "stopped" && !await probeHost({ socket: host.socket, timeoutMs: 1200 });
    }
    if (passed && cleaned) await rm(base, { recursive: true, force: true });
    else {
      console.error(`Private peer restart fixture retained: ${base}; cleanup=${cleaned}`);
      if (passed && !cleaned) throw Error("Owned Native peer host cleanup was refused");
    }
  }
}, 180000);
