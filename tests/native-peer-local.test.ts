import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RpcClient, stopHost, probeHost } from "@code-yeongyu/senpi";

type Frame = { type: string; id?: string; command?: string; success?: boolean; data?: Record<string, unknown>;
  title?: string; method?: string; toolCallId?: string; isError?: boolean; result?: unknown };
type Chat = { model?: string; messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>; tools?: Array<{ function?: { name?: string } }> };

// Real pinned Native tool, real isolated Senpi socket host and real local HTTP
// provider route. Only the LM Studio HTTP model wire is synthetic.
test("Mini Native peer runs on the selected local instance, not a global host", async () => {
  const base = await mkdtemp(join(tmpdir(), "mini-peer-"));
  // Hermetic: the fixture home is the Native home boundary, so no config walk reaches a real home.
  const home = join(base, "home"), root = join(home, "work"), state = join(home, "mini-state"), temp = join(base, "temp");
  await mkdir(root, { recursive: true }); await mkdir(temp);
  const wire: Chat[] = []; const frames: Frame[] = [];
  const allowSend = Promise.withResolvers<void>();
  const sendReached = Promise.withResolvers<void>();
  let createdId: string | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: ["alpha", "beta"].map(key => ({
      key, type: "llm", capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: `${key}-instance`, config: { context_length: 65536 } }],
    })) });
    if (path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = await request.json() as Chat; wire.push(body);
    const messages = JSON.stringify(body.messages);
    const has = (token: string) => messages.includes(token);
    const lastUser = JSON.stringify(body.messages?.filter(m => m.role === "user").at(-1)?.content);
    const early = lastUser.includes("EARLY-PEER-ALPHA") && !has("alpha-create");
    const earlyTurn = lastUser.includes("EARLY-PEER-ALPHA");
    const child = body.messages?.some(m => m.role === "user" && JSON.stringify(m.content).includes("PEER-REQUEST-614")) && !has("PEER-LOCAL-614");
    const search = has("peer-find") && !has("peer-create");
    const create = has("peer-create") && !has("peer-send");
    const created = body.messages?.findLast(message => message.role === "tool" && message.tool_call_id === "peer-create");
    const resultText = typeof created?.content === "string" ? created.content : undefined;
    const id = resultText?.startsWith("{") ? (JSON.parse(resultText) as { thread?: { thread_id?: string } }).thread?.thread_id : undefined;
    const send = has("peer-send") && !has("PEER-LOCAL-614");
    const forkRequest = lastUser.includes("FORK-PEER-614") && !has("fork-create");
    const denyRequest = lastUser.includes("DENY-CLOUD-THREAD") && !has("deny-cloud");
    const next = child ? { content: "PEER-LOCAL-614" }
      : early ? { tool_calls: [{ index: 0, id: "alpha-create", type: "function", function: { name: "thread_create", arguments: JSON.stringify({ name: "alpha-peer" }) } }] }
      : earlyTurn ? { content: "ALPHA-PEER-CREATED" }
      : forkRequest && createdId ? { tool_calls: [{ index: 0, id: "fork-create", type: "function", function: { name: "thread_create", arguments: JSON.stringify({ name: "forked-mini-peer", fork_from: createdId }) } }] }
      : denyRequest && createdId ? { tool_calls: [{ index: 0, id: "deny-cloud", type: "function", function: { name: "thread_set_model", arguments: JSON.stringify({ thread: createdId, model: "openai/gpt-4o" }) } }] }
      : !has("peer-find") ? { tool_calls: [{ index: 0, id: "peer-find", type: "function", function: { name: "tool_search", arguments: JSON.stringify({ query: "Create session" }) } }] }
      : search ? { tool_calls: [{ index: 0, id: "peer-create", type: "function", function: { name: "thread_create", arguments: JSON.stringify({ name: "mini-local-peer" }) } }] }
      : create && id ? { tool_calls: [{ index: 0, id: "peer-send", type: "function", function: { name: "thread_send", arguments: JSON.stringify({ thread: id, message: "PEER-REQUEST-614", delivery: "follow_up" }) } }] }
      : send ? { content: "PARENT-LOCAL-DONE" } : { content: "PARENT-LOCAL-DONE" };
    if (create && id && "tool_calls" in next) { sendReached.resolve(); await allowSend.promise; }
    const calls = "tool_calls" in next;
    return new Response(`data: ${JSON.stringify({ id: "peer", object: "chat.completion.chunk", choices: [{ index: 0, delta: next, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "peer", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const proc = spawn(process.execPath, [process.env["MINI_PEER_CLI"] ?? "src/cli.ts", "rpc", "--root", root, "--state-dir", state,
    "--base-url", `http://127.0.0.1:${server.port}/v1`],
    { cwd: resolve(import.meta.dir, ".."), env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "", buffer = ""; const listeners = new Set<(frame: Frame) => void>();
  proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame; frames.push(frame);
      if (frame.type === "extension_ui_request" && frame.method === "select" && frame.id)
        proc.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Allow once" }) + "\n");
      for (const listener of listeners) listener(frame);
    }
  });
  const wait = (matches: (frame: Frame) => boolean) => {
    const task = new Promise<Frame>((accept, reject) => {
      const done = () => { clearTimeout(timer); listeners.delete(onFrame); proc.off("exit", onExit); };
      const onExit = () => { done(); reject(Error(`Native exited: ${stderr.slice(-1200)}`)); };
      const onFrame = (frame: Frame) => { if (matches(frame)) { done(); accept(frame); } };
      const timer = setTimeout(() => { done(); reject(Error(`Native deadline: ${stderr.slice(-1400)} ${JSON.stringify(frames.slice(-8))}`)); }, 90000);
      listeners.add(onFrame); proc.once("exit", onExit);
    });
    void task.catch(() => {}); return task;
  };
  let passed = false;
  try {
    const earlyEnd = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "alpha-create");
    const earlyTurn = wait(frame => frame.type === "agent_end");
    const earlyAck = wait(frame => frame.type === "response" && frame.id === "alpha-prompt");
    proc.stdin!.write(JSON.stringify({ id: "alpha-prompt", type: "prompt", message: "EARLY-PEER-ALPHA" }) + "\n");
    expect((await earlyAck).success).toBe(true);
    const earlyResult = await earlyEnd;
    expect(JSON.stringify(earlyResult.result)).toContain('"kind":"ok"');
    await earlyTurn;
    const alpha = (earlyResult.result as { details?: { result?: { thread?: { sessionId?: string; thread_id?: string } } } }).details?.result?.thread;
    expect(alpha?.thread_id).toBeTruthy();
    const alphaWire = wire.length;
    const model = wait(frame => frame.type === "response" && frame.id === "switch");
    proc.stdin!.write(JSON.stringify({ id: "switch", type: "set_model", provider: "omo-mini-local", modelId: "beta" }) + "\n");
    expect((await model).success).toBe(true);
    const created = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "peer-create");
    const sent = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "peer-send");
    const parent = wait(frame => frame.type === "agent_end");
    const ack = wait(frame => frame.type === "response" && frame.id === "prompt");
    const completion = Promise.all([created, sent, parent, ack]);
    void completion.catch(() => {}); // A failed assertion below must surface itself, not this exit.
    proc.stdin!.write(JSON.stringify({ id: "prompt", type: "prompt", message: "Create a peer and send it the local fixture request." }) + "\n");
    const createEnd = await created;
    expect(createEnd.isError, JSON.stringify(createEnd.result)).toBe(false);
    expect(JSON.stringify(createEnd.result)).toContain('"kind":"ok"');
    const details = (createEnd.result as { details?: { result?: { thread?: { thread_id?: string; sessionPath?: string } } } })?.details?.result;
    createdId = details?.thread?.thread_id;
    expect(createdId).toBeTruthy();
    const dirs = await readdir(join(state, "agent", "rpc-host-daemon"));
    const settings = await Promise.all(dirs.map(async dir => {
      try { return JSON.parse(await readFile(join(state, "agent", "rpc-host-daemon", dir, "settings.json"), "utf8")) as { socket: string }; }
      catch { return undefined; }
    }));
    const sockets = settings.flatMap(entry => entry?.socket ? [entry.socket] : []);
    expect(sockets).toHaveLength(2);
    const matches = await Promise.all(sockets.map(async socket => {
      const control = new RpcClient({ socketPath: socket });
      await control.start();
      try { return (await control.listSessions()).some(peer => peer.durableSessionId === createdId) ? socket : undefined; }
      finally { await control.stop(); }
    }));
    const socket = matches.find(Boolean);
    expect(socket).toBeTruthy();
    const observer = new RpcClient({ socketPath: socket! });
    await observer.start();
    try {
      const attached = await observer.openSession({ sessionPath: details!.thread!.sessionPath!, cwd: root });
      expect(attached.attached).toBe(true);
      const hostState = await observer.getState();
      expect(hostState.model?.provider).toBe("omo-mini-local");
      expect(hostState.model?.id).toBe("beta-instance");
      const surfaces = await observer.requestSession({ type: "get_loaded_surfaces" }, attached.sessionId);
      // The guard extension is whichever build of Mini launched the caller.
      expect(JSON.stringify(surfaces["extensions"])).toContain(process.env["MINI_PEER_CLI"]?.endsWith(".js") ? "extension.js" : "extension.ts");
      expect(JSON.stringify(surfaces["extensions"])).toContain("omo.js");
      await new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => reject(Error("Fake model did not reach Native thread_send gate")), 30000);
        void sendReached.promise.then(() => { clearTimeout(timer); accept(); }, error => { clearTimeout(timer); reject(error); });
      });
      const peerDone = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { off(); reject(Error("Native peer agent_end deadline")); }, 45000);
        const off = observer.onEvent(event => {
          if (event.type === "agent_end") { clearTimeout(timer); off(); accept(); }
        });
      });
      allowSend.resolve();
      await peerDone;
    } finally { allowSend.resolve(); await observer.stop(); }
    await parent;
    if (!frames.some(frame => frame.type === "tool_execution_end" && frame.toolCallId === "peer-send"))
      throw Error(`No Native thread_send before agent_end: ${JSON.stringify(wire.map(body => body.messages?.slice(-2).map(m => ({ role: m.role, id: m.tool_call_id }))))}`);
    const [, sendEnd, , accepted] = await completion;
    expect(accepted.success).toBe(true);
    expect(sendEnd.isError, JSON.stringify(sendEnd.result)).toBe(false);
    expect(JSON.stringify(createEnd.result)).toContain("thread_id");
    const peerWire = wire.find(body => JSON.stringify(body.messages).includes("PEER-REQUEST-614"));
    expect(peerWire).toBeDefined();
    expect(peerWire?.model).toBe("beta-instance");
    expect(wire.slice(0, alphaWire).every(body => body.model === "alpha-instance")).toBe(true);
    expect(wire.slice(alphaWire).some(body => body.model === "beta-instance")).toBe(true);
    expect(details!.thread!.thread_id).not.toBe(alpha?.thread_id);
    expect(details!.thread!.sessionPath).toContain(base);
    const configs = JSON.parse(await readFile(join(state, "agent", "models.json"), "utf8"));
    expect(Object.keys(configs.providers)).toEqual(["omo-mini-local"]);
    const forkEnd = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "fork-create");
    const forkTurn = wait(frame => frame.type === "agent_end");
    const forkAck = wait(frame => frame.type === "response" && frame.id === "fork-turn");
    proc.stdin!.write(JSON.stringify({ id: "fork-turn", type: "prompt", message: "FORK-PEER-614" }) + "\n");
    expect((await forkAck).success).toBe(true);
    const forked = await forkEnd;
    expect(JSON.stringify(forked.result)).toContain('"kind":"ok"');
    await forkTurn;
    const forkThread = (forked.result as { details?: { result?: { thread?: { sessionPath?: string } } } }).details?.result?.thread;
    expect(forkThread?.sessionPath).toBeTruthy();
    const transcript = await readFile(forkThread!.sessionPath!, "utf8");
    expect(transcript).toContain("PEER-REQUEST-614");
    expect(transcript).toContain("PEER-LOCAL-614");
    expect(forkThread!.sessionPath).not.toBe(details!.thread!.sessionPath);
    const denyEnd = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "deny-cloud");
    const denyTurn = wait(frame => frame.type === "agent_end");
    const denyAck = wait(frame => frame.type === "response" && frame.id === "deny-turn");
    proc.stdin!.write(JSON.stringify({ id: "deny-turn", type: "prompt", message: "DENY-CLOUD-THREAD" }) + "\n");
    expect((await denyAck).success).toBe(true);
    const refused = await denyEnd;
    expect(JSON.stringify(refused.result)).toContain('"kind":"error"');
    await denyTurn;
    expect(wire.every(body => body.model === "alpha-instance" || body.model === "beta-instance")).toBe(true);
    passed = true;
  } finally {
    const exited = proc.exitCode !== null || proc.signalCode !== null;
    const exit = exited ? Promise.resolve() : new Promise<void>(resolveExit => {
      const timer = setTimeout(() => { proc.kill(); }, 15000);
      proc.once("exit", () => { clearTimeout(timer); resolveExit(); });
    });
    proc.stdin!.end(); await exit;
    server.stop(true);
    const daemonDir = join(state, "agent", "rpc-host-daemon");
    const names = await readdir(daemonDir).catch(() => []);
    let clean = true;
    for (const name of names) {
      let socket: string | undefined;
      try { socket = (JSON.parse(await readFile(join(daemonDir, name, "settings.json"), "utf8")) as { socket: string }).socket; }
      catch { continue; }
      if (!socket.includes(base)) throw Error("Refusing to stop a host outside owned fixture");
      const result = await stopHost({ socket, agentDir: join(state, "agent"), force: true });
      if (result.action !== "stopped" && await probeHost({ socket, timeoutMs: 1200 })) clean = false;
    }
    if (clean && passed) await rm(base, { recursive: true, force: true });
    else console.error(`Private fixture retained: ${base}; host cleanup=${clean}`);
  }
}, 120000);
