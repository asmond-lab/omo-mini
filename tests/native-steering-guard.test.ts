import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const Call = z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) });
const Message = z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional(), tool_calls: z.array(Call).optional() });
const Wire = z.object({ messages: z.array(Message) });
const Frame = z.object({ type: z.string(), id: z.string().optional(), success: z.boolean().optional(),
  toolCallId: z.string().optional(), isError: z.boolean().optional(), willRetry: z.boolean().optional(),
  method: z.string().optional(), title: z.string().optional(), options: z.array(z.string()).optional() }).passthrough();

test("native active-run user steer permits a repeated file inspection", async () => {
  // Given two identical successful inspections while one agent run is active.
  const root = await mkdtemp(join(tmpdir(), "omo-mini-steer-guard-"));
  const state = join(root, "state");
  const file = join(root, "sample.txt");
  await writeFile(file, "TOKEN:ALPHA\n");
  await mkdir(join(root, ".omo"));
  await writeFile(join(root, ".omo", "omo.json"), JSON.stringify({ memory: {
    reflection: { enabled: false }, facts: { enabled: false }, dream: { enabled: false },
    recall: { enabled: false }, nudge: { enabled: false },
  } }));

  const wires: z.infer<typeof Wire>[] = [];
  let releaseHeldResponse: (() => void) | undefined;
  let notifyHeldRequest: (() => void) | undefined;
  const heldResponse = new Promise<void>(resolveHeld => { releaseHeldResponse = resolveHeld; });
  const heldRequest = new Promise<void>(resolveRequest => { notifyHeldRequest = resolveRequest; });
  let step = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v0/models") return Response.json({ data: [{ id: "progress-local", state: "loaded", type: "llm", loaded_context_length: 69376, capabilities: ["tool_use"] }] });
    if (path !== "/v1/chat/completions") return new Response("missing", { status: 404 });
    wires.push(Wire.parse(await request.json()));
    const index = step++;
    if (index === 2) { notifyHeldRequest?.(); await heldResponse; }
    const grep = { pattern: "TOKEN", path: "sample.txt", mode: "content" };
    // Grep and bash are eval-only in Native; exercise their real nested bridge.
    const inspect = { name: "eval", arguments: { language: "js", summary: "Inspect the local fixture using grep.",
      code: `const observation = await tool.grep(${JSON.stringify(grep)}); print(JSON.stringify({ hasError: observation.hasError, text: observation.text }));` } };
    const barrier = { name: "eval", arguments: { language: "js", summary: "Observe the fixture steering barrier.",
      code: `const observation = await tool.bash({ command: "printf 'STEER-BARRIER-817\\n'" }); print(JSON.stringify({ hasError: observation.hasError, text: observation.text }));` } };
    const actions = [
      barrier, inspect, inspect, inspect,
    ];
    const action = actions[index];
    const delta = action ? { tool_calls: [{ index: 0, id: `steer-${index + 1}`, type: "function", function: {
      name: action.name, arguments: JSON.stringify(action.arguments),
    } }] } : { content: "DONE" };
    const finish = action ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: "steering", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "steering", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });

  const entry = process.env["OMO_PROGRESS_BUILT"] === "1" ? "dist/cli.js" : "src/cli.ts";
  const proc = spawn(process.execPath, [entry, "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`],
    { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>(accept => { proc.once("exit", () => accept()); });
  const listeners = new Set<(frame: z.infer<typeof Frame>) => void>();
  const toolEnds: z.infer<typeof Frame>[] = [];
  let agentEnds = 0;
  const approvedTools: string[] = [];
  let buffer = "";
  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.startsWith("{")) {
        const frame = Frame.parse(JSON.parse(line));
        const permission = /^Permission required: (eval|bash|grep)\n/.exec(frame.title ?? "")?.[1];
        if (frame.type === "extension_ui_request" && frame.method === "select" && permission) {
          expect(frame.options).toContain("Allow once");
          approvedTools.push(permission);
          proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Allow once" }) + "\n");
        }
        if (frame.type === "tool_execution_end") toolEnds.push(frame);
        if (frame.type === "agent_end") agentEnds++;
        for (const listener of listeners) listener(frame);
      }
      at = buffer.indexOf("\n");
    }
  });
  const wait = (matches: (frame: z.infer<typeof Frame>) => boolean) => new Promise<z.infer<typeof Frame>>((accept, reject) => {
    const listener = (frame: z.infer<typeof Frame>) => { if (matches(frame)) { clearTimeout(timer); listeners.delete(listener); accept(frame); } };
    const timer = setTimeout(() => { listeners.delete(listener); reject(Error(`RPC timeout: ${stderr.slice(-800)}`)); }, 60000);
    listeners.add(listener);
  });

  try {
    // When a real RPC user steer is queued while the next provider request is in flight.
    const promptAck = wait(frame => frame.type === "response" && frame.id === "prompt");
    const end = wait(frame => frame.type === "agent_end" && !frame.willRetry);
    proc.stdin.write(JSON.stringify({ type: "prompt", id: "prompt", message: "Inspect the harmless sample twice, then follow any user steering." }) + "\n");
    expect((await promptAck).success, stderr).toBe(true);
    await heldRequest;
    const steerAck = wait(frame => frame.type === "response" && frame.id === "steer");
    proc.stdin.write(JSON.stringify({ type: "steer", id: "steer", message: "Please inspect sample.txt again and report its TOKEN value." }) + "\n");
    expect((await steerAck).success, stderr).toBe(true);
    releaseHeldResponse?.();
    await end;

    // Then the steering request is delivered within the same run and its inspection executes.
    expect(agentEnds).toBe(1);
    expect(approvedTools).toContain("eval");
    expect(JSON.stringify(wires[3]?.messages)).toContain("Please inspect sample.txt again");
    const finalWire = wires.at(-1);
    const calls = finalWire?.messages.flatMap(message => message.tool_calls ?? []) ?? [];
    const results = finalWire?.messages.filter(message => message.role === "tool") ?? [];
    expect(calls.map(call => call.id)).toEqual(["steer-1", "steer-2", "steer-3", "steer-4"]);
    expect(results.map(result => result.tool_call_id)).toEqual(calls.map(call => call.id));
    const shellObservation = JSON.parse(String(results[0]?.content)) as { hasError: boolean; text: string };
    expect(shellObservation.hasError).toBe(false);
    expect(shellObservation.text).toContain("STEER-BARRIER-817");
    const barrierEval = toolEnds.find(frame => frame.toolCallId === "steer-1") as (z.infer<typeof Frame> & {
      result?: { details?: { toolCalls?: { name: string; ok: boolean }[] } }
    }) | undefined;
    expect(barrierEval?.result?.details?.toolCalls?.some(call => call.name === "bash" && call.ok)).toBe(true);
    const lastObservation = JSON.parse(String(results[3]?.content)) as { hasError: boolean; text: string };
    expect(lastObservation.hasError).toBe(false);
    expect(lastObservation.text).toContain("TOKEN:ALPHA");
    expect(JSON.stringify(results[3]?.content)).not.toContain("<local_tool_recovery>");
    expect(toolEnds.filter(frame => frame.toolCallId?.startsWith("steer-")).map(frame => frame.isError)).toEqual([false, false, false, false]);
    expect(await readFile(file, "utf8")).toBe("TOKEN:ALPHA\n");
  } finally {
    releaseHeldResponse?.();
    proc.stdin.end();
    const killTimer = setTimeout(() => proc.kill(), 5000);
    try { await exited; } finally { clearTimeout(killTimer); }
    server.stop(true);
    const inside = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(inside) || inside.startsWith(".." + sep) || !inside.startsWith("omo-mini-steer-guard-")) throw Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
}, 150000);
