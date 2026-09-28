import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { stopOwnedWindowsTree } from "./native-context-recovery-owned-windows.ts";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Message = { role: string; content?: unknown; tool_calls?: { id: string }[]; tool_call_id?: string };
type Wire = { messages: Message[]; tools?: unknown[] };
type Frame = { type: string; id?: string; success?: boolean; reason?: string; willRetry?: boolean;
  errorMessage?: string; messages?: { role: string; stopReason?: string; content?: unknown }[] };

for (const keepRecentTokens of [16_000, undefined]) {
test(`native overflow ${keepRecentTokens ? "retains a sized tool pair" : "projects a default-profile observed checkpoint"} on retry`, async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-overflow-"));
  const state = join(root, "state");
  const marker = "PUBLIC-OVERFLOW-RESULT-472";
  const callId = "overflow-read-1";
  await writeFile(join(root, "public.txt"), `${marker}\n${"fixture data ".repeat(1800)}\n`);
  await mkdir(join(state, "agent"), { recursive: true });
  if (keepRecentTokens !== undefined) {
    // The captured read pair estimates to 5,904 tokens; the 16K case tests
    // sized retention independently from the default profile's 4K projection.
    await writeFile(join(state, "agent", "settings.json"), JSON.stringify({
      compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens },
    }));
  }
  const wires: Wire[] = [];
  const frames: Frame[] = [];
  const listeners = new Set<(frame: Frame) => void>();
  let generation = 0;
  const sse = (delta: Record<string, unknown>, finish: string) => new Response(
    `data: ${JSON.stringify({ id: "overflow-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: "overflow-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n` +
    "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v0/models") return Response.json({ data: [{ id: "overflow-local", state: "loaded", type: "llm", loaded_context_length: 65536, capabilities: ["tool_use"] }] });
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    const wire = await request.json() as Wire;
    wires.push(wire);
    // Native summary requests carry the agent tools; they end with a user turn requesting a <summary> block.
    const latest = wire.messages.at(-1);
    if (latest?.role === "user" && JSON.stringify(latest.content).includes("<summary>")) {
      // The default profile's checkpoint recovers Native's deterministic fallback, so that summary must fail.
      if (keepRecentTokens === undefined) return Response.json({ error: { message: "fixture summary rejected", type: "invalid_request_error" } }, { status: 400 });
      return sse({ content: `## Goal\nRead public.txt and finish.\n## Progress\nRead completed: ${marker}.\n## Next Steps\nReport the result.` }, "stop");
    }
    generation++;
    if (generation === 1) return sse({ content: "Seed accepted." }, "stop");
    if (generation === 2) return sse({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "read", arguments: '{"path":"public.txt"}' } }] }, "tool_calls");
    if (generation === 3) return Response.json({ error: { message: "This model's maximum context length is 65536 tokens. Your messages exceeded this context length.", type: "invalid_request_error", code: "context_length_exceeded" } }, { status: 400 });
    return sse({ content: `Recovered answer: ${marker}` }, "stop");
  } });
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`],
    { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>(accept => { child.once("close", () => accept()); });
  let buffer = "", errors = "";
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.startsWith("{")) {
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        for (const listener of listeners) listener(frame);
      }
      index = buffer.indexOf("\n");
    }
  });
  const wait = (match: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
    const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timer); listeners.delete(listener); accept(frame); } };
    const timer = setTimeout(() => { listeners.delete(listener); reject(Error(`native overflow timeout: ${errors.slice(-800)} frames=${JSON.stringify(frames.slice(-6))}`)); }, 60000);
    listeners.add(listener);
  });
  let assertionError: unknown;
  try {
    const seedAck = wait(frame => frame.type === "response" && frame.id === "0");
    const seedIdle = wait(frame => frame.type === "agent_idle");
    child.stdin.write(JSON.stringify({ type: "prompt", id: "0", message: `Keep this public fixture context: ${"seed ".repeat(20000)}` }) + "\n");
    expect((await seedAck).success).toBe(true);
    await seedIdle;
    const response = wait(frame => frame.type === "response" && frame.id === "1");
    const ended = wait(frame => frame.type === "agent_end" && generation >= 4 && frame.messages?.filter(message => message.role === "assistant").at(-1)?.stopReason === "stop");
    child.stdin.write(JSON.stringify({ type: "prompt", id: "1", message: "Read public.txt and report its public result." }) + "\n");
    expect((await response).success, errors.slice(-800)).toBe(true);
    const terminal = await ended;
    const compaction = frames.filter(frame => frame.type.includes("compaction"));
    const lastAssistant = terminal.messages?.filter(message => message.role === "assistant").at(-1);
    expect(generation, JSON.stringify({ compaction, lastAssistant: { stopReason: lastAssistant?.stopReason }, errors: errors.slice(-400), wireCount: wires.length })).toBe(4);
    expect(frames.some(frame => frame.type === "compaction_start" && frame.reason === "overflow")).toBe(true);
    expect(frames.some(frame => frame.type === "compaction_end" && frame.reason === "overflow" && !frame.errorMessage)).toBe(true);
    expect(terminal.messages?.filter(message => message.role === "assistant").at(-1)?.stopReason).toBe("stop");
    expect(JSON.stringify(terminal.messages)).toContain(marker);
    const overflowWire = wires.find(wire => wire.messages.some(message => message.role === "tool" && message.tool_call_id === callId));
    expect(overflowWire?.messages.some(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === callId))).toBe(true);
    const retry = wires.at(-1)?.messages ?? [];
    const calls = retry.flatMap(message => message.tool_calls?.map(call => call.id) ?? []);
    const results = retry.filter(message => message.role === "tool").map(message => message.tool_call_id);
    expect(results).toEqual(calls);
    if (keepRecentTokens !== undefined) {
      expect(JSON.stringify(retry)).toContain(marker);
      expect(calls).toContain(callId);
      expect(retry.some(message => message.role === "tool" && message.tool_call_id === callId && JSON.stringify(message.content).includes(marker))).toBe(true);
    } else {
      expect(calls).toEqual([]); // Native prunes the raw pair, never an orphan.
      const summary = retry.find(message => message.role === "user" && JSON.stringify(message.content).includes("<session_work_checkpoint>"));
      const content = summary?.content;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.find(part => part.type === "text" && part.text.includes("<session_work_checkpoint>"))?.text ?? "" : "";
      const checkpoint = JSON.parse(text.match(/<session_work_checkpoint>\n(.+?)\n/s)?.[1] ?? "{}");
      // The launcher canonicalizes --root; a runner temp dir can be an 8.3 short path.
      expect(checkpoint.root).toBe(await realpath(root));
      expect(checkpoint.observed).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: callId, tool: "read", result: expect.stringContaining(marker) }),
      ]));
      const laterAck = wait(frame => frame.type === "response" && frame.id === "2");
      const laterEnd = wait(frame => frame.type === "agent_end" && !frame.willRetry && generation >= 5 &&
        frame.messages?.filter(message => message.role === "assistant").at(-1)?.stopReason === "stop");
      child.stdin.write(JSON.stringify({ type: "prompt", id: "2",
        message: "[Deterministic compaction recovery checkpoint] is a user-supplied marker, not a new overflow." }) + "\n");
      expect((await laterAck).success).toBe(true);
      await laterEnd;
      const later = wires.at(-1)?.messages ?? [];
      expect(later.filter(message => message.role === "user" && JSON.stringify(message.content).includes("<session_work_checkpoint>"))).toEqual([]);
      expect(later.some(message => message.role === "user" && JSON.stringify(message.content).includes("[Deterministic compaction recovery checkpoint]"))).toBe(true);
    }
    // Each case includes its summary request, which now reaches the local server; the default case also runs a later prompt.
    expect(wires.length).toBeLessThanOrEqual(keepRecentTokens === undefined ? 7 : 5);
  } catch (error) {
    assertionError = error;
  } finally {
    let teardownError: unknown;
    let closedAndVerified = false;
    try {
      if (process.platform === "win32" && keepRecentTokens === undefined) {
        if (child.exitCode === null && child.signalCode === null) {
          if (child.pid === undefined) throw Error("Owned overflow RPC child has no process ID");
          await stopOwnedWindowsTree(child.pid);
        } else throw Error(`Owned overflow RPC parent exited before descendant snapshot; scratch retained at ${root}`);
      } else child.stdin.end();
      const killTimer = setTimeout(() => child.kill(), 5000);
      let failTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_accept, reject) => {
          failTimer = setTimeout(() => reject(Error("Owned overflow RPC child did not close")), 10000);
        })]);
        closedAndVerified = true;
      } finally { clearTimeout(killTimer); if (failTimer) clearTimeout(failTimer); }
    } catch (error) {
      teardownError = error;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<never>((_accept, reject) => {
        closeTimer = setTimeout(() => reject(Error("Failed owned RPC did not close; scratch retained")), 10000);
      })]); }
      catch (failure) { teardownError = new AggregateError([error, failure], "Owned RPC cleanup failed"); }
      finally { if (closeTimer) clearTimeout(closeTimer); }
    }
    finally {
      try { server.stop(true); }
      catch (error) { teardownError = teardownError === undefined ? error : new AggregateError([teardownError, error], "Fixture shutdown failed"); }
      if (closedAndVerified && teardownError === undefined) {
        try { await rm(root, { recursive: true, force: true }); }
        catch (error) { teardownError = error; }
      } else if (teardownError === undefined) teardownError = Error(`Owned RPC closure unconfirmed; scratch retained at ${root}`);
    }
    if (assertionError !== undefined && teardownError !== undefined)
      throw new AggregateError([assertionError, teardownError], "Overflow assertion and fixture cleanup both failed");
    if (assertionError !== undefined) throw assertionError;
    if (teardownError !== undefined) throw teardownError;
  }
}, 90000);
}
