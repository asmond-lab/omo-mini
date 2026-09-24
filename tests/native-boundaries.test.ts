import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type: string; id?: string; success?: boolean; data?: Record<string, unknown>; messages?: unknown[] };
type Message = { role?: string; tool_calls?: { id: string }[]; tool_call_id?: string; content?: unknown };

// Real launcher, OmO/Senpi RPC and pi-ai transport; only the model HTTP wire is fake.
test("native multi-pair history, live MCP inventory and disposable global profile isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-boundaries-"));
  const global = join(root, "fake-global");
  const state = join(root, "state");
  const marker = "PUBLIC-FAKE-GLOBAL-DO-NOT-ADOPT";
  const ids = ["boundary-pair-1", "boundary-pair-2", "boundary-pair-3"];
  const requests: { messages: Message[]; tools?: { function?: { name?: string }; name?: string }[] }[] = [];
  const frames: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  let proc: ReturnType<typeof spawn> | undefined;
  let buffer = "";
  let errors = "";
  let nextId = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v0/models") return Response.json({ data: [{ id: "boundary-local", state: "loaded", type: "llm", loaded_context_length: 34000, capabilities: ["tool_use"] }] });
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    requests.push(await request.json() as (typeof requests)[number]);
    const pair = ids[requests.length - 1];
    const delta = pair ? { tool_calls: [{ index: 0, id: pair, type: "function", function: { name: "read", arguments: '{"path":"public.txt"}' } }] } : { content: "Native boundary complete." };
    const finish = pair ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: "boundary", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "boundary", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  function wait(match: (frame: Frame) => boolean): Promise<Frame> {
    return new Promise((accept, reject) => {
      const onFrame = (frame: Frame) => { if (match(frame)) { clearTimeout(timeout); listeners.delete(onFrame); accept(frame); } };
      const timeout = setTimeout(() => { listeners.delete(onFrame); reject(new Error(`RPC timeout: ${errors.slice(-1200)}`)); }, 45000);
      listeners.add(onFrame);
    });
  }
  function send(type: string, extra: Record<string, unknown> = {}): Promise<Frame> {
    const id = String(++nextId);
    const response = wait(frame => frame.type === "response" && frame.id === id);
    proc!.stdin!.write(JSON.stringify({ id, type, ...extra }) + "\n");
    return response;
  }
  async function prompt(message: string): Promise<void> {
    const ended = wait(frame => frame.type === "agent_end");
    const response = await send("prompt", { message });
    expect(response.success).toBe(true);
    await ended;
  }
  try {
    await mkdir(global, { recursive: true });
    await writeFile(join(global, "models.json"), JSON.stringify({ providers: { "fake-global-cloud": { apiKey: marker } } }));
    await writeFile(join(global, "settings.json"), marker);
    await writeFile(join(root, "public.txt"), `PUBLIC-NATIVE-PAIR-172\n${"P".repeat(1100)}\n`);
    await writeFile(join(root, "AGENTS.md"), "PROJECT-RULE-ONLY-FROM-AGENTS-417\n");
    const before = await Promise.all([readFile(join(global, "models.json"), "utf8"), readFile(join(global, "settings.json"), "utf8")]);
    proc = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`], {
      cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_PROVIDER: "chatgpt-subscription", PI_MODEL: "gpt-6-sol", OPENAI_API_KEY: marker, OMO_CODING_AGENT_DIR: global, PI_CODING_AGENT_DIR: global, HOME: global, USERPROFILE: global },
    });
    proc.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    proc.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (line.startsWith("{")) {
          const frame = JSON.parse(line) as Frame;
          frames.push(frame);
          for (const listener of listeners) listener(frame);
        }
        index = buffer.indexOf("\n");
      }
    });
    const surfaces = await send("get_loaded_surfaces");
    expect(surfaces.success).toBe(true);
    const mcpServers = surfaces.data?.["mcpServers"] as { name: string }[];
    const extensions = surfaces.data?.["extensions"] as { path: string }[];
    expect(extensions.map(extension => extension.path).some(path => path.includes(global))).toBe(false);
    await prompt("Read public.txt three times using the read tool and report the public value.");
    expect(requests.length, `RPC frames: ${JSON.stringify(frames.slice(-8))}; stderr: ${errors.slice(-1200)}`).toBe(4);
    for (let index = 0; index < 3; index++) {
      const next = requests[index + 1]!.messages;
      expect(next.some(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === ids[index]))).toBe(true);
      expect(next.some(message => message.role === "tool" && message.tool_call_id === ids[index] && JSON.stringify(message.content).includes("PUBLIC-NATIVE-PAIR-172"))).toBe(true);
    }
    const terminal = frames.filter(frame => frame.type === "agent_end").at(-1);
    const terminalAssistant = (terminal?.messages as { role: string; stopReason?: string; errorMessage?: string }[] | undefined)?.filter(message => message.role === "assistant").at(-1);
    const after = await Promise.all([readFile(join(global, "models.json"), "utf8"), readFile(join(global, "settings.json"), "utf8")]);
    const localModels = JSON.parse(await readFile(join(state, "agent", "models.json"), "utf8"));
    const localSettings = await readFile(join(state, "agent", "settings.json"), "utf8");
    const receipt = { invocation: "bun test tests/native-boundaries.test.ts (native src/cli.ts rpc, disposable root/state, 127.0.0.1 ephemeral SSE)", context: 34000,
      toolPairIds: ids, generationRequests: requests.length, finalRequestBytes: Buffer.byteLength(JSON.stringify(requests.at(-1))),
      pairsOnNextWire: ids.map((id, index) => ({ id, call: requests[index + 1]?.messages.some(m => m.role === "assistant" && m.tool_calls?.some(c => c.id === id)), result: requests[index + 1]?.messages.some(m => m.role === "tool" && m.tool_call_id === id) })),
      finalRequestPairs: ids.map(id => ({ id, call: requests.at(-1)?.messages.some(m => m.role === "assistant" && m.tool_calls?.some(c => c.id === id)), result: requests.at(-1)?.messages.some(m => m.role === "tool" && m.tool_call_id === id) })),
      terminalAssistant: { stopReason: terminalAssistant?.stopReason, errorMessage: terminalAssistant?.errorMessage },
      mcpServers, extensionPaths: extensions.map(extension => extension.path), firstRequestToolNames: requests[0]?.tools?.map(tool => tool.function?.name ?? tool.name),
      globalSentinelsUnchanged: before.every((value, index) => value === after[index]), localProviderNames: Object.keys(localModels.providers), localSettingsContainsMarker: localSettings.includes(marker), stderrTail: errors.slice(-1200) };
    if (process.env["OMO_BOUNDARY_ARTIFACT_DIR"]) await writeFile(join(process.env["OMO_BOUNDARY_ARTIFACT_DIR"], "runtime.json"), JSON.stringify(receipt, null, 2));
    expect(requests.length).toBe(4);
    expect(JSON.stringify(requests[0])).toContain("PROJECT-RULE-ONLY-FROM-AGENTS-417");
    expect(JSON.stringify(requests[0])).toContain("read");
    expect(JSON.stringify(requests[0])).toContain("edit");
    expect(JSON.stringify(requests[0])).toContain("bash");
    expect(JSON.stringify(requests[0])).toContain("write");
    expect(Buffer.byteLength(JSON.stringify(requests[0]))).toBeLessThan(34394);
    // Drive several complete tool pairs into the loaded window, not just one
    // short pair with abundant headroom. Never accept an orphaned result.
    expect(receipt.finalRequestBytes).toBeGreaterThan(20000);
    expect(receipt.finalRequestPairs.every(pair => pair.call && pair.result)).toBe(true);
    expect(receipt.globalSentinelsUnchanged).toBe(true);
    expect(receipt.localProviderNames).toEqual(["omo-mini-local"]);
    expect(receipt.localSettingsContainsMarker).toBe(false);
    expect(JSON.stringify(requests)).not.toContain(marker);
    expect(mcpServers.map(server => server.name)).not.toContain("context7");
    expect(mcpServers.map(server => server.name)).not.toContain("grep_app");
  } finally {
    if (proc && proc.exitCode === null) {
      const exit = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("RPC child did not exit after cleanup signal")), 10000);
        proc!.once("exit", () => { clearTimeout(timer); accept(); });
      });
      proc.stdin?.end();
      proc.kill();
      await exit;
    }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 160000);
