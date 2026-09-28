import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

const Call = z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) });
const Message = z.object({ role: z.string(), content: z.unknown().optional(), tool_call_id: z.string().optional(), tool_calls: z.array(Call).optional() });
const Wire = z.object({ messages: z.array(Message) });
const Frame = z.object({ type: z.string(), id: z.string().optional(), success: z.boolean().optional(),
  toolCallId: z.string().optional(), isError: z.boolean().optional(), willRetry: z.boolean().optional(),
  method: z.string().optional(), title: z.string().optional(), options: z.array(z.string()).optional(),
  messages: z.array(z.object({ role: z.string(), stopReason: z.string().optional() }).passthrough()).optional() }).passthrough();

test("native repeated successful observations recover before another identical file search", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-progress-"));
  const state = join(root, "state");
  const file = join(root, "sample.txt");
  await writeFile(file, "TOKEN:ALPHA\n");
  await mkdir(join(root, ".omo"));
  await writeFile(join(root, ".omo", "omo.json"), JSON.stringify({ memory: {
    reflection: { enabled: false }, facts: { enabled: false }, dream: { enabled: false },
    recall: { enabled: false }, nudge: { enabled: false },
  } }));

  const wires: { scenario: string; wire: z.infer<typeof Wire> }[] = [];
  let scenario: "file" | "shell" | "missing" = "file";
  let step = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v0/models") return Response.json({ data: [{ id: "progress-local", state: "loaded", type: "llm", loaded_context_length: 69376, capabilities: ["tool_use"] }] });
    if (path !== "/v1/chat/completions") return new Response("missing", { status: 404 });
    const wire = Wire.parse(await request.json());
    wires.push({ scenario, wire });
    const index = step++;
    const grep = { pattern: "TOKEN", path: "sample.txt", mode: "content" };
    const inspect = { name: "eval", arguments: { language: "js", summary: "Inspect the local fixture using grep.",
      code: `const observation = await tool.grep(${JSON.stringify(grep)}); print(JSON.stringify({ hasError: observation.hasError, text: observation.text }));` } };
    const shell = (command: string) => ({ name: "eval", arguments: { language: "js", summary: "Run the local fixture shell action.",
      code: `const observation = await tool.bash(${JSON.stringify({ command })}); print(JSON.stringify({ hasError: observation.hasError, text: observation.text }));` } });
    const action = scenario === "file" ? [
      inspect, inspect,
      inspect, { name: "write", arguments: { path: "sample.txt", content: "TOKEN:BETA\n" } },
      inspect,
    ][index] : scenario === "shell" ? index < 2 ? shell("printf 'SHELL-CONSTANT-817\\n'") : undefined : [
      { name: "read", arguments: { path: "missing.txt" } },
      shell("printf 'UNRELATED-OK\\n'"),
      { name: "read", arguments: { path: "missing.txt" } },
      shell("printf 'RECOVERED-913\\n' > missing.txt"),
      { name: "read", arguments: { path: "missing.txt" } },
    ][index];
    const delta = action ? { tool_calls: [{ index: 0, id: `${scenario}-${index + 1}`, type: "function", function: {
      name: action.name, arguments: JSON.stringify(action.arguments),
    } }] } : { content: "DONE" };
    const finish = action ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: "progress", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "progress", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const entry = process.env["OMO_PROGRESS_BUILT"] === "1" ? "dist/cli.js" : "src/cli.ts";
  const proc = spawn(process.execPath, [entry, "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`],
    { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>(accept => { proc.once("close", () => accept()); });
  const listeners = new Set<(frame: z.infer<typeof Frame>) => void>();
  const toolEnds: z.infer<typeof Frame>[] = [];
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
  async function prompt(id: string, message: string): Promise<void> {
    const ack = wait(frame => frame.type === "response" && frame.id === id);
    const end = wait(frame => frame.type === "agent_end" && !frame.willRetry);
    proc.stdin.write(JSON.stringify({ type: "prompt", id, message }) + "\n");
    expect((await ack).success, stderr).toBe(true);
    const last = (await end).messages?.filter(item => item.role === "assistant").at(-1);
    expect(last?.stopReason, stderr).toBe("stop");
  }
  try {
    await prompt("1", "FILE_SCENARIO: inspect the harmless sample and continue after changing it.");
    const fileWires = wires.filter(item => item.scenario === "file").map(item => item.wire);
    expect(approvedTools).toContain("eval");
    const finalFile = fileWires.at(-1);
    expect(fileWires.length).toBe(6);
    expect(finalFile).toBeDefined();
    const calls = finalFile?.messages.flatMap(message => message.tool_calls ?? []) ?? [];
    const results = finalFile?.messages.filter(message => message.role === "tool") ?? [];
    expect(calls.map(call => call.id)).toEqual(["file-1", "file-2", "file-3", "file-4", "file-5"]);
    expect(results.map(result => result.tool_call_id)).toEqual(calls.map(call => call.id));
    const observation = (index: number) => JSON.parse(String(results[index]?.content)) as { hasError: boolean; text: string };
    const first = observation(0), second = observation(1), changed = observation(4);
    expect(first.hasError).toBe(false);
    expect(first.text).toContain("TOKEN:ALPHA");
    expect(second.hasError).toBe(false);
    expect(second.text).toContain("TOKEN:ALPHA");
    // A blocked nested grep throws ExecuteToolError before the eval cell's print.
    // Check the real failed eval and its nested tool metadata, not a fabricated JSON return.
    const blockedText = String(results[2]?.content ?? "");
    expect(blockedText).toContain("<local_tool_recovery>");
    const priorNestedCall = /"toolCallId":"(codemode-[0-9a-f-]+)"/.exec(blockedText)?.[1];
    expect(priorNestedCall).toBeDefined();
    expect(blockedText).toContain("TOKEN:ALPHA");
    const blockedEval = toolEnds.find(frame => frame.toolCallId === "file-3") as (z.infer<typeof Frame> & {
      result?: { details?: { toolCalls?: { name: string; ok: boolean; error?: string }[] } }
    }) | undefined;
    const nestedFailure = blockedEval?.result?.details?.toolCalls?.find(call => call.name === "grep");
    expect(nestedFailure?.ok).toBe(false);
    expect(nestedFailure?.error).toContain("<local_tool_recovery>");
    expect(changed.hasError).toBe(false);
    expect(changed.text).toContain("TOKEN:BETA");
    const output = results.map(result => JSON.stringify(result.content));
    expect(toolEnds.filter(frame => frame.toolCallId?.startsWith("file-")).map(frame => frame.isError))
      .toEqual([false, false, false, false, false]);
    expect(await readFile(file, "utf8")).toBe("TOKEN:BETA\n");

    scenario = "shell";
    step = 0;
    await prompt("2", "BASH_SCENARIO: inspect a constant twice, then finish.");
    const shellWires = wires.filter(item => item.scenario === "shell").map(item => item.wire);
    expect(shellWires.length).toBe(3);
    const shellFinal = shellWires.at(-1);
    const shellCalls = shellFinal?.messages.flatMap(message => message.tool_calls ?? []).filter(call => call.id.startsWith("shell-")) ?? [];
    const shellResults = shellFinal?.messages.filter(message => message.role === "tool" && message.tool_call_id?.startsWith("shell-")) ?? [];
    expect(shellResults.map(result => result.tool_call_id)).toEqual(shellCalls.map(call => call.id));
    const shellObservations = shellResults.map(result => JSON.parse(String(result.content)) as { hasError: boolean; text: string });
    expect(shellObservations.map(result => result.hasError)).toEqual([false, false]);
    expect(shellObservations.map(result => result.text)).toEqual([
      expect.stringContaining("SHELL-CONSTANT-817"), expect.stringContaining("SHELL-CONSTANT-817"),
    ]);
    expect(JSON.stringify(shellFinal?.messages)).toContain("<local_tool_recovery>");
    expect(toolEnds.filter(frame => frame.toolCallId?.startsWith("shell-")).every(frame => frame.isError === false)).toBe(true);
    scenario = "missing";
    step = 0;
    await prompt("3", "MISSING_SCENARIO: inspect a missing harmless file, create it, and verify it.");
    const missingWires = wires.filter(item => item.scenario === "missing").map(item => item.wire);
    expect(missingWires.length).toBe(6);
    const missingFinal = missingWires.at(-1);
    const missingCalls = missingFinal?.messages.flatMap(message => message.tool_calls ?? []).filter(call => call.id.startsWith("missing-")) ?? [];
    const missingResults = missingFinal?.messages.filter(message => message.role === "tool" && message.tool_call_id?.startsWith("missing-")) ?? [];
    expect(missingResults.map(result => result.tool_call_id)).toEqual(missingCalls.map(call => call.id));
    const missingOutput = missingResults.map(result => JSON.stringify(result.content));
    expect(missingOutput[0]).toContain("ENOENT");
    const unrelated = JSON.parse(String(missingResults[1]?.content)) as { hasError: boolean; text: string };
    expect(unrelated.hasError).toBe(false);
    expect(unrelated.text).toContain("UNRELATED-OK");
    expect(missingOutput[2]).not.toBe(missingOutput[0]);
    const repaired = JSON.parse(String(missingResults[3]?.content)) as { hasError: boolean; text: string };
    expect(repaired.hasError).toBe(false);
    expect(missingOutput[4]).toContain("RECOVERED-913");
    expect(toolEnds.filter(frame => frame.toolCallId?.startsWith("missing-")).map(frame => frame.isError))
      .toEqual([true, false, true, false, false]);
    expect(await readFile(join(root, "missing.txt"), "utf8")).toBe("RECOVERED-913\n");
    if (process.env["OMO_PROGRESS_EVIDENCE_DIR"]) await writeFile(join(process.env["OMO_PROGRESS_EVIDENCE_DIR"], "tool-progress-wire-2026-09-25.json"),
      JSON.stringify({ redBaseline: { command: "bun test tests/native-tool-progress.test.ts", failure: "third identical grep executed and returned TOKEN:ALPHA without local_tool_recovery" },
        green: { command: "bun test tests/native-tool-progress.test.ts", filePairs: results.map(result => result.tool_call_id),
          fileErrors: toolEnds.filter(frame => frame.toolCallId?.startsWith("file-")).map(frame => ({ id: frame.toolCallId, isError: frame.isError })),
          firstTwoObserved: [first, second].map(item => item.text.includes("TOKEN:ALPHA")), thirdBlocked: nestedFailure?.ok === false && blockedText.includes("<local_tool_recovery>") && priorNestedCall !== undefined,
          afterWriteObserved: changed.text.includes("TOKEN:BETA"), shellPairs: shellResults.map(result => result.tool_call_id),
          shellReminder: JSON.stringify(shellFinal?.messages).includes("<local_tool_recovery>"),
          shellErrors: toolEnds.filter(frame => frame.toolCallId?.startsWith("shell-")).map(frame => ({ id: frame.toolCallId, isError: frame.isError })),
          missingPairs: missingResults.map(result => result.tool_call_id), missingErrors: toolEnds.filter(frame => frame.toolCallId?.startsWith("missing-")).map(frame => ({ id: frame.toolCallId, isError: frame.isError })),
          missingThirdDiffers: missingOutput[2] !== missingOutput[0], missingRecovered: missingOutput[4]?.includes("RECOVERED-913") } }, null, 2));
  } finally {
    let teardownError: unknown;
    try {
      if (process.platform === "win32") {
        // Kill only this test-owned RPC tree while its parent PID still exists.
        // Closing stdin first can orphan the eval kernel's Windows cwd handle.
        if (proc.exitCode === null && proc.signalCode === null) {
          if (proc.pid === undefined) throw Error("Owned RPC child has no process ID");
          const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
          const killed = await new Promise<number | null>((accept, reject) => {
            const timer = setTimeout(() => { killer.kill(); reject(Error("Owned RPC tree kill timed out")); }, 10000);
            killer.once("error", error => { clearTimeout(timer); reject(error); });
            killer.once("close", code => { clearTimeout(timer); accept(code); });
          });
          expect(killed).toBe(0);
        }
      } else proc.stdin.end();
      const killTimer = setTimeout(() => proc.kill(), 5000);
      let failTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_accept, reject) => {
          failTimer = setTimeout(() => reject(Error("Owned RPC child did not close")), 10000);
        })]);
      } finally { clearTimeout(killTimer); if (failTimer) clearTimeout(failTimer); }
    } catch (error) { teardownError = error; }
    finally {
      try { server.stop(true); }
      catch (error) { teardownError = teardownError === undefined ? error : new AggregateError([teardownError, error], "Fixture shutdown failed"); }
      try {
        expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
        expect(basename(root).startsWith("omo-mini-progress-")).toBe(true);
        await rm(root, { recursive: true, force: true });
      } catch (error) { teardownError = teardownError === undefined ? error : new AggregateError([teardownError, error], "Fixture cleanup failed"); }
    }
    if (teardownError !== undefined) throw teardownError;
  }
}, 150000);
