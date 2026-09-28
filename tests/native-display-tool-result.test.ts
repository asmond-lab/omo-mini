import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real Native RPC and fake loopback model: a failing bash result passed to display() must
// reach the model with bun's (fail) line, not cut off inside one column-clamped JSON line.
test("Native eval display of a failing bash result keeps the test failure visible to the model", async () => {
  const base = await mkdtemp(join(tmpdir(), "omo-mini-display-result-"));
  const root = join(base, "workspace"), state = join(base, "state");
  await mkdir(root, { recursive: true });
  // Long source lines precede the failing test, so bun's excerpt before (fail) exceeds 768 columns once JSON-escaped.
  const padding = Array.from({ length: 5 }, (_, index) => `test("padding ${index}", () => { expect(["alpha", "beta", "gamma", "delta"].map(value => value.toUpperCase()).join(",")).toBe("ALPHA,BETA,GAMMA,DELTA"); });`);
  await writeFile(join(root, "fixture.test.ts"), ['import { expect, test } from "bun:test";', ...padding,
    'test("fixture fails on purpose", () => { expect(["label", "hello world"].join(" ")).toBe("hello world"); });', ""].join("\n"));
  const wire: Array<{ messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }> }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [{ key: "fixture", type: "llm", capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "fixture", config: { context_length: 65536 } }] }] });
    if (path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    wire.push(await request.json());
    const delta = wire.length === 1 ? { tool_calls: [{ index: 0, id: "display-fail", type: "function", function: { name: "eval", arguments: JSON.stringify({
      language: "js", summary: "Run the fixture test", code: 'display(await tool.bash({ command: "bun test fixture.test.ts" }));',
    }) } }] } : { content: "Display probe done." };
    return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: wire.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  type Frame = { type: string; id?: string; success?: boolean; title?: string; method?: string };
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state,
    "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "", stderr = ""; const listeners = new Set<(frame: Frame) => void>(); const timers = new Set<ReturnType<typeof setTimeout>>();
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      if (frame.type === "extension_ui_request" && frame.method === "select") {
        const name = /^Permission required: ([^\n]+)/.exec(frame.title ?? "")?.[1];
        child.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: name === "eval" || name === "bash" ? "Allow once" : "Deny" }) + "\n");
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
    // Subscribe to both signals before triggering the turn.
    const completion = Promise.all([wait(frame => frame.type === "response" && frame.id === "probe"), wait(frame => frame.type === "agent_end")]);
    child.stdin!.write(JSON.stringify({ type: "prompt", id: "probe", message: "Run the fixture test." }) + "\n");
    const [accepted] = await completion;
    expect(accepted?.success).toBe(true);
    const content = wire[1]?.messages?.find(message => message.role === "tool" && message.tool_call_id === "display-fail")?.content;
    const visible = typeof content === "string" ? content : JSON.stringify(content);
    expect(visible).toContain("(fail) fixture fails on purpose");
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
