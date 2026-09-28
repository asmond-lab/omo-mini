import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DeniedError } from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/permission-system/types.js";

test("OmO denies a destructive nested bash tool before executing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-permission-"));
  await writeFile(join(root, "marker.txt"), "untouched");
  let generations = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [{ key: "fixture", type: "llm",
      capabilities: { trained_for_tool_use: true, vision: false }, loaded_instances: [{ id: "fixture", config: { context_length: 200000 } }] }] });
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    generations++;
    const delta = generations === 1 ? { tool_calls: [{ index: 0, id: "destructive", type: "function", function: { name: "eval", arguments: JSON.stringify({
      language: "js", code: 'display(await tool.bash({ command: "rm -rf marker.txt" }));', summary: "Check destructive command denial",
    }) } }] } : { content: "Denied command; no deletion performed." };
    return new Response(`data: ${JSON.stringify({ id: "permission", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "permission", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: generations === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  type Frame = { type: string; id?: string; success?: boolean; method?: string; title?: string; options?: string[];
    toolName?: string; toolCallId?: string; result?: { details?: { isError?: boolean; toolCalls?: Array<{ name: string; ok: boolean; args?: { command?: string }; error?: string }> } } };
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", join(root, "state"),
    "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "", stderr = "";
  const listeners = new Set<(frame: Frame) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
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
  const wait = (match: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
    const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timer); timers.delete(timer); listeners.delete(listener); accept(frame); } };
    const timer = setTimeout(() => { timers.delete(timer); listeners.delete(listener); reject(Error(`Native permission timeout: ${stderr.slice(-500)}`)); }, 45000);
    timers.add(timer); listeners.add(listener);
  });
  try {
    const result = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "destructive");
    const ended = wait(frame => frame.type === "agent_end");
    const ack = wait(frame => frame.type === "response" && frame.id === "prompt");
    child.stdin!.write(JSON.stringify({ id: "prompt", type: "prompt", message: "Do not remove marker.txt" }) + "\n");
    expect((await ack).success).toBe(true);
    const evalResult = await result;
    await ended;
    expect(evalResult.toolName).toBe("eval");
    expect(evalResult.result?.details?.isError).toBe(true);
    expect(evalResult.result?.details?.toolCalls?.some(call => call.name === "bash" && call.ok === false && call.args?.command === "rm -rf marker.txt")).toBe(true);
    const denied = evalResult.result?.details?.toolCalls?.find(call => call.name === "bash" && call.args?.command === "rm -rf marker.txt");
    expect(denied?.error?.split("\n")[0]).toBe(new DeniedError([]).message); // Match Native's shipped rule-denial reason, not generic tool failure.
    expect(approvals).toEqual(["eval"]); // The bash deny rule is never approved away.
    expect(generations).toBe(2);
    expect(await readFile(join(root, "marker.txt"), "utf8")).toBe("untouched");
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear(); listeners.clear();
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error(`RPC child did not exit: ${stderr.slice(-500)}`)); }, 10000);
      child.once("exit", () => { clearTimeout(timer); accept(); });
    });
    child.stdin!.end();
    try { await exited; } finally { try { server.stop(true); } finally { await rm(root, { recursive: true, force: true }); } }
  }
}, 90000);
