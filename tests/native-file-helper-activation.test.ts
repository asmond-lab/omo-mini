import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real Native RPC, fake loopback model, and real nested tool execution/reinjection.
test("Native eval invokes workspace ls, find and grep instead of returning inactive", async () => {
  const base = await mkdtemp(join(tmpdir(), "omo-mini-helper-activation-"));
  const root = join(base, "workspace"), state = join(base, "state");
  await mkdir(join(root, "files", "nested"), { recursive: true });
  await writeFile(join(root, "files", "nested", "probe.txt"), "HELPER-SENTINEL-729\n");
  const wire: Array<{ tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }> }> = [];
  const routes: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [{ key: "fixture", type: "llm", capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "fixture", config: { context_length: 65536 } }] }] });
    if (path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    routes.push(path); wire.push(await request.json());
    const calls = [
      ['ls', 'display(await tool.ls({path:"."}));'],
      ['find', 'display(await tool.find({pattern:"**/*.txt",path:"files"}));'],
      ['grep', 'display(await tool.grep({pattern:"HELPER-SENTINEL-729",path:"files/nested/probe.txt"}));'],
    ] as const;
    const call = calls[wire.length - 1];
    const delta = call ? { tool_calls: [{ index: 0, id: "helpers-" + call[0], type: "function", function: { name: "eval", arguments: JSON.stringify({
      language: "js", summary: "Inspect disposable workspace using Native file helper", code: call[1],
    }) } }] } : { content: "Helper probe done." };
    return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  type Frame = { type: string; id?: string; success?: boolean; title?: string; method?: string; toolCallId?: string; toolName?: string;
    result?: { details?: { toolCalls?: Array<{ name: string; ok: boolean; error?: string; result?: unknown }> }; content?: unknown } };
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state,
    "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "", stderr = ""; const listeners = new Set<(frame: Frame) => void>(); const timers = new Set<ReturnType<typeof setTimeout>>();
  const approvals: string[] = [];
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      if (frame.type === "extension_ui_request" && frame.method === "select") {
        const name = /^Permission required: ([^\n]+)/.exec(frame.title ?? "")?.[1] ?? "unknown";
        approvals.push(name);
        child.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: name === "eval" ? "Allow once" : "Deny" }) + "\n");
      }
      for (const listener of listeners) listener(frame);
    }
  });
  const wait = (matches: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
    const listener = (frame: Frame) => { if (matches(frame)) { clearTimeout(timer); timers.delete(timer); listeners.delete(listener); accept(frame); } };
    const timer = setTimeout(() => { timers.delete(timer); listeners.delete(listener); reject(Error(`Native RPC timeout: ${stderr.slice(-800)}`)); }, 45000);
    timers.add(timer); listeners.add(listener);
  });
  try {
    const results = ["ls", "find", "grep"].map(name => wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "helpers-" + name));
    const ended = wait(frame => frame.type === "agent_end");
    const ack = wait(frame => frame.type === "response" && frame.id === "probe");
    // Attach one aggregate rejection handler to every signal before triggering the turn.
    const completion = Promise.all([ack, ...results, ended]);
    child.stdin!.write(JSON.stringify({ type: "prompt", id: "probe", message: "Inspect probe.txt with the registered Native file helpers." }) + "\n");
    const [accepted, ...observed] = await completion;
    expect(accepted?.success).toBe(true);
    expect(observed.at(-1)?.type).toBe("agent_end");
    const evalResults = observed.slice(0, 3);
    const nested = evalResults.flatMap(frame => frame.result?.details?.toolCalls ?? []);
    expect(evalResults.map(frame => frame.toolName)).toEqual(["eval", "eval", "eval"]);
    const available = wire[0]?.tools?.map(tool => tool.function?.name);
    for (const name of ["eval", "task", "lsp_diagnostics"]) expect(available).toContain(name);
    expect(nested.map(call => call.name)).toEqual(["ls", "find", "grep"]);
    expect(nested.every(call => call.ok)).toBe(true);
    expect(JSON.stringify(evalResults.map(frame => frame.result))).toContain("probe.txt");
    expect(JSON.stringify(evalResults.map(frame => frame.result))).toContain("HELPER-SENTINEL-729");
    for (const [index, name] of ["ls", "find", "grep"].entries())
      expect(wire[index + 1]?.messages?.some(message => message.role === "tool" && message.tool_call_id === "helpers-" + name)).toBe(true);
    expect(routes).toHaveLength(4);
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every(name => name === "eval")).toBe(true);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); listeners.clear();
    let exited = child.exitCode !== null || child.signalCode !== null;
    const stopped = exited ? Promise.resolve() : new Promise<void>((accept, reject) => {
      const onExit = () => { clearTimeout(force); clearTimeout(deadline); accept(); };
      const force = setTimeout(() => { child.kill(); }, 10000);
      const deadline = setTimeout(() => { child.off("exit", onExit); reject(Error(`RPC child did not exit; retained ${base}: ${stderr.slice(-800)}`)); }, 20000);
      child.once("exit", onExit);
    });
    child.stdin!.end();
    try { await stopped; exited = true; }
    finally { try { server.stop(true); } finally { if (exited) await rm(base, { recursive: true, force: true }); } }
  }
}, 90000);
