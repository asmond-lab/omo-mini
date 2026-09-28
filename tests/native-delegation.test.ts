import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Frame = { type: string; id?: string; success?: boolean; method?: string; title?: string; options?: string[];
  toolName?: string; toolCallId?: string; isError?: boolean; result?: { content?: unknown }; messages?: unknown[] };
type Chat = { model?: string; messages?: { role?: string; tool_call_id?: string; content?: unknown }[] };

test("Native foreground quick task completes through the selected local child model", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-delegation-"));
  const chat: Chat[] = [], paths: string[] = [], frames: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  let processChild: ReturnType<typeof spawn> | undefined;
  let buffer = "", errors = "", approvals = 0;
  const instruction = "CHILD-INSTRUCTION-762";
  const answer = "CHILD-ANSWER-762";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === "/api/v1/models") return Response.json({ models: [{
      key: "parity-local", type: "llm", max_context_length: 262144,
      capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "parity-local", config: { context_length: 65536 } }],
    }] });
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    const body = await request.json() as Chat;
    chat.push(body);
    const text = JSON.stringify(body.messages);
    // Parent history includes the task arguments after the first tool call, so do not
    // identify child traffic by a substring alone. The correlated task result wins.
    const resumedParent = body.messages?.some(message => message.role === "tool" && message.tool_call_id === "task-call-1" && JSON.stringify(message.content).includes(answer)) ?? false;
    const child = !resumedParent && text.includes(instruction);
    const delta = child ? { content: answer }
      : resumedParent ? { content: "Delegation finished." }
      : { tool_calls: [{ index: 0, id: "task-call-1", type: "function", function: {
          name: "task", arguments: JSON.stringify({ category: "quick", task_summary: "Return the fixture child answer",
            prompt: `Reply ${instruction} using exactly ${answer} and no tools.`, run_in_background: false }),
        } }] };
    const finish = child || resumedParent ? "stop" : "tool_calls";
    return new Response(`data: ${JSON.stringify({ id: "local-child", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local-child", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const pending = new Set<(reason: Error) => void>();
  function wait(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const result = new Promise<Frame>((accept, reject) => {
      const clear = () => { clearTimeout(timer); listeners.delete(onFrame); pending.delete(cancel); };
      const cancel = (reason: Error) => { clear(); reject(reason); };
      const onFrame = (frame: Frame) => { if (predicate(frame)) { clear(); accept(frame); } };
      const timer = setTimeout(() => cancel(new Error(`Native delegation deadline: paths=${JSON.stringify(paths)} chat=${chat.length} frames=${JSON.stringify(frames.slice(-8))} stderr=${errors.slice(-900)}`)), 60000);
      listeners.add(onFrame);
      pending.add(cancel);
    });
    // An earlier assertion can fail before another subscribed event arrives; keep the
    // original rejection visible to its awaiter while preventing an unhandled late rejection.
    void result.catch(() => {});
    return result;
  }
  try {
    processChild = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", join(root, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`],
      { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    processChild.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    processChild.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line.startsWith("{")) {
          const frame = JSON.parse(line) as Frame;
          frames.push(frame);
          if (frame.type === "extension_ui_request" && frame.method === "select" && /^Permission required: task\n/.test(frame.title ?? "")) {
            expect(frame.options).toContain("Allow once");
            approvals++;
            processChild!.stdin!.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Allow once" }) + "\n");
          }
          for (const listener of listeners) listener(frame);
        }
        end = buffer.indexOf("\n");
      }
    });
    const started = wait(frame => frame.type === "tool_execution_start" && frame.toolCallId === "task-call-1");
    const finished = wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "task-call-1");
    const ended = wait(frame => frame.type === "agent_end");
    const response = wait(frame => frame.type === "response" && frame.id === "1");
    processChild.stdin!.write(JSON.stringify({ id: "1", type: "prompt", message: "Delegate a trivial local task to the quick category, then summarize its result." }) + "\n");
    expect((await response).success).toBe(true);
    await started;
    const outcome = await finished;
    expect(outcome.isError, `task result: ${JSON.stringify(outcome.result)}`).toBe(false);
    expect(JSON.stringify(outcome.result?.content)).toContain(answer);
    await ended;
    expect(paths).toContain("/api/v1/models");
    expect(paths).not.toContain("/api/v0/models");
    expect(approvals).toBe(1);
    const childRequest = chat.find(body => body.messages?.some(message => message.role === "user" && JSON.stringify(message.content).includes(instruction)));
    expect(childRequest?.model).toBe("parity-local");
    expect(childRequest).toBeDefined();
    expect(chat.every(body => body.model === "parity-local")).toBe(true);
    expect(chat.some(body => body.messages?.some(message => message.role === "tool" && message.tool_call_id === "task-call-1" && JSON.stringify(message.content).includes(answer)))).toBe(true);
    expect(JSON.stringify(frames.filter(frame => frame.type === "agent_end").at(-1))).toContain("Delegation finished.");
    // The child ran in-process on every platform, so it shared this launcher's flags.
    const taskDir = join(root, "state", "senpi-task", "tasks");
    const tasks = await Promise.all((await readdir(taskDir)).filter(name => name.endsWith(".json"))
      .map(async name => JSON.parse(await readFile(join(taskDir, name), "utf8")) as { execution_mode?: string }));
    expect(tasks.map(task => task.execution_mode)).toEqual(["in-process"]);
  } finally {
    for (const cancel of pending) cancel(new Error("Native delegation fixture stopped"));
    if (processChild && processChild.exitCode === null) {
      const exit = new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("Native delegation RPC did not stop")), 10000);
        processChild!.once("exit", () => { clearTimeout(timer); accept(); });
      });
      processChild.stdin?.end(); processChild.kill(); await exit;
    }
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
