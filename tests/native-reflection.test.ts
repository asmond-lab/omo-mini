import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

const frameSchema = z.object({ type: z.string(), id: z.string().optional(), success: z.boolean().optional(), method: z.string().optional(), message: z.string().optional().catch(undefined), willRetry: z.boolean().optional() });
const wireSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() })), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() });
const completionSchema = z.object({ runId: z.literal("reflection-run-1"), outcome: z.string(), model: z.string(), filesChanged: z.number().optional(), mergedCommitSha: z.string().optional() });
const ledgerSchema = z.object({ runId: z.literal("reflection-run-1"), worktreeDir: z.string(), pid: z.number().int().positive().optional(), childPid: z.number().int().positive().optional() });
type Frame = z.infer<typeof frameSchema>;
type Wire = z.infer<typeof wireSchema>;

test("native reflection reviews a failed command and commits self-awareness for a new session", async () => {
  // Given: an isolated native memory identity and a local model HTTP endpoint.
  const base = await mkdtemp(join(tmpdir(), "omo-mini-reflection-"));
  const root = join(base, "한글-프로젝트"), state = join(base, "state");
  await mkdir(join(root, ".omo"), { recursive: true });
  await Bun.write(join(root, ".omo", "omo.json"), JSON.stringify({ memory: {
    facts: { enabled: false }, dream: { enabled: false }, recall: { enabled: false }, nudge: { enabled: false },
    reflection: { enabled: true, trigger: { step_count: 0, on_compaction: false } },
  } }));
  const model = "reflection-local", marker = "FAILED-COMMAND-OBSERVED-823";
  const requests: Wire[] = []; let parentCalls = 0, childCalls = 0, sawFailure = false;
  const childCatalogs: string[][] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/v0/models") return Response.json({ data: [{ id: model, state: "loaded", type: "llm", loaded_context_length: 69376, capabilities: ["tool_use"] }] });
    if (pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const wire = wireSchema.parse(await request.json()); requests.push(wire);
    const catalog = wire.tools?.map(item => item.function.name) ?? [];
    const structuredChild = catalog.includes("reflection_input");
    const legacyChild = catalog.join(",") === "bash,edit";
    const child = structuredChild || legacyChild;
    const history = JSON.stringify(wire.messages);
    const call = (name: string, args: Record<string, unknown>, number: number) => ({ tool_calls: [{ index: 0, id: `reflection-${number}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    let delta: Record<string, unknown> = { content: "ACK" };
    if (child) {
      childCatalogs.push(catalog);
      childCalls++;
      if (childCalls === 1) delta = structuredChild
        ? call("reflection_input", {}, childCalls)
        : call("bash", { command: "bun -e \"process.stdout.write(require('fs').readFileSync(process.env.TRANSCRIPT_PATH,'utf8'))\"" }, childCalls);
      if (childCalls === 2) {
        sawFailure = history.includes(marker) && history.includes("49");
        if (sawFailure) {
          const content = `---\ndescription: Observed shell-action correction\n---\n\n- cond: failed shell action | obs: ${marker} exit 49 | next: inspect result before retry\n`;
          if (structuredChild) delta = call("write", { path: "system/self-aware.md", content }, childCalls);
          else {
            const encoded = Buffer.from(content).toString("base64");
            const reference = Buffer.from("---\ndescription: Disposable tool-routing reference\n---\n\nPrefer observed tool results.\n").toString("base64");
            delta = call("bash", { command: `bun -e "const fs=require('fs');fs.mkdirSync('system',{recursive:true});fs.mkdirSync('reference/tooling',{recursive:true});fs.writeFileSync('system/self-aware.md',Buffer.from('${encoded}','base64'));fs.writeFileSync('reference/tooling/windows-tool-routing.md',Buffer.from('${reference}','base64'))"` }, childCalls);
          }
        }
      }
      if (structuredChild) {
        if (childCalls === 3) delta = call("write", { path: "reference/tooling/windows-tool-routing.md", content: "---\ndescription: Disposable tool-routing reference\n---\n\nPrefer observed tool results.\n" }, childCalls);
        if (childCalls === 4) delta = call("reflection_commit", { paths: ["system/self-aware.md", "reference/tooling/windows-tool-routing.md"], message: "observed-failure" }, childCalls);
      } else {
        if (childCalls === 3) delta = call("bash", { command: "git add system/self-aware.md reference/tooling/windows-tool-routing.md" }, childCalls);
        if (childCalls === 4) delta = call("bash", { command: "git -c user.name=ReflectionTest -c user.email=reflection@example.invalid commit -m observed-failure" }, childCalls);
      }
    } else if (history.includes("Execute failure fixture") && ++parentCalls === 1) {
      delta = call("bash", { command: `bun -e "console.error('${marker}');process.exit(49)"` }, 100);
    }
    const finish = "tool_calls" in delta ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: "reflection-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "reflection-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const built = process.env["OMO_REFLECTION_BUILT"] === "1";
  const proc = spawn(process.execPath, [built ? "dist/cli.js" : "src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "", errors = ""; const frames: Frame[] = [], listeners = new Set<(frame: Frame) => void>();
  proc.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString(); let at = buffer.indexOf("\n");
    while (at >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (line.startsWith("{")) { const frame = frameSchema.parse(JSON.parse(line)); frames.push(frame); for (const listener of listeners) listener(frame); }
      at = buffer.indexOf("\n");
    }
  });
  const wait = (match: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
    const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timer); listeners.delete(listener); accept(frame); } };
    const timer = setTimeout(() => { listeners.delete(listener); reject(Error(`RPC timeout: ${errors.slice(-1000)} ${JSON.stringify(frames.slice(-5))}`)); }, 60000);
    listeners.add(listener);
  });
  let id = 0;
  async function send(message: string, idle = false) {
    const requestId = String(++id), ack = wait(frame => frame.type === "response" && frame.id === requestId);
    const end = idle ? wait(frame => frame.type === "agent_end" && !frame.willRetry) : undefined;
    proc.stdin.write(JSON.stringify({ type: "prompt", id: requestId, message }) + "\n");
    const response = await ack; if (end) await end;
    expect(response.success, `${message}: ${errors}`).toBe(true);
    return response;
  }
  let reflectionTimedOut = false, memoryPath: string | undefined;
  try {
    // When: a user asks native /reflect after a failed action.
    await send("/memfs init");
    await send("Execute failure fixture and report the failed result.", true);
    const identity = (await readdir(join(state, "memory", "agents")))[0];
    expect(identity).toBeTruthy();
    if (!identity) throw Error("Native memory identity missing");
    const memory = join(state, "memory", "agents", identity);
    memoryPath = memory;
    const repo = join(memory, "repo");
    await send("/reflect Review the failed shell result");
    // Then: native reflection must be enabled before a worker can run.
    const notifications = frames.filter(frame => frame.method === "notify").map(frame => frame.message ?? "").join(" ");
    expect(notifications).toContain("reflection run");
    expect(notifications).not.toContain("reflection is disabled");
    const completions = join(memory, "runtime", "reflection", "completions");
    const completionPath = join(completions, "reflection-run-1.json");
    const completed = new Promise<z.infer<typeof completionSchema>>((accept, reject) => {
      let settled = false;
      const watcher = watch(join(memory, "runtime"), { recursive: true }, () => { void check().catch(fail); });
      const timeout = setTimeout(() => { void (async () => {
        reflectionTimedOut = true;
        const run = join(memory, "runtime", "reflection", "runs", "reflection-run-1");
        const childError = await readFile(join(run, "child-stderr.log"), "utf8").catch(() => "");
        const ledger = await readFile(join(run, "ledger.json"), "utf8").catch(() => "");
        fail(Error(`Reflection completion timeout; childCalls=${childCalls} stderr=${errors.slice(-1000)} child-stderr=${childError.slice(-1000)} ledger=${ledger.slice(-1000)}`));
      })(); }, 60000);
      function finish(result: z.infer<typeof completionSchema>) {
        if (settled) return;
        settled = true; clearTimeout(timeout); watcher.close(); accept(result);
      }
      function fail(error: unknown) {
        if (settled) return;
        settled = true; clearTimeout(timeout); watcher.close(); reject(error);
      }
      async function check() {
        const raw = await readFile(completionPath, "utf8").catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (raw === undefined) return;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch (error) { if (error instanceof SyntaxError) return; throw error; }
        const result = completionSchema.safeParse(parsed);
        if (result.success) finish(result.data);
      }
      void check().catch(fail);
    });
    const [, completion] = await Promise.all([send("Settle reflection launch.", true), completed]);
    expect(completion).toMatchObject({ outcome: "merged", model: `omo-mini-local/${model}`, filesChanged: 2 });
    expect(completion.mergedCommitSha).toBeTruthy();
    expect(sawFailure).toBe(true);
    expect(childCalls).toBeGreaterThanOrEqual(4);
    expect(childCatalogs.length).toBeGreaterThan(0);
    for (const catalog of childCatalogs) {
      expect(catalog).toContain("reflection_input");
      expect(catalog).toContain("reflection_commit");
      expect(catalog).not.toContain("bash");
    }
    const learned = await readFile(join(repo, "system", "self-aware.md"), "utf8");
    expect(learned).toContain(marker);
    expect(await readdir(repo)).not.toContain(".tmp");
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    const history = execFileSync("git", ["-C", repo, "log", "-2", "--format=%s"], { encoding: "utf8" }).trim().split(/\r?\n/);
    expect(history).toEqual(["merge(reflection): manual reflection-run-1", "observed-failure"]);
    const newId = String(++id), newAck = wait(frame => frame.type === "response" && frame.id === newId);
    proc.stdin.write(JSON.stringify({ type: "new_session", id: newId }) + "\n");
    expect((await newAck).success).toBe(true);
    const before = requests.length;
    await send("Check a new session's memory.", true);
    const projected = requests.slice(before).flatMap(wire => wire.messages)
      .filter(message => message.role === "system").map(message => typeof message.content === "string" ? message.content : "").join("\n");
    expect(projected).toContain(marker);
    expect(projected).toContain("windows-tool-routing.md");
    expect(projected).toContain(repo);
    expect(projected).not.toContain("$MEMORY_DIR");
    expect(projected.match(/<!-- senpi-memory:([^:\r\n]+):begin -->/)?.[1]).toBe(identity);
    expect(projected.match(/- AGENT_ID: ([^\r\n]+)/)?.[1]).toBe(identity);
  } finally {
    const exit = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { proc.kill(); reject(Error("RPC exit timeout")); }, 10000);
      proc.once("exit", () => { clearTimeout(timer); accept(); });
    });
    if (reflectionTimedOut && memoryPath) {
      const ledgerPath = join(memoryPath, "runtime", "reflection", "runs", "reflection-run-1", "ledger.json");
      const raw = await readFile(ledgerPath, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (raw) {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        const ledger = ledgerSchema.safeParse(parsed);
        if (ledger.success && resolve(ledger.data.worktreeDir).startsWith(resolve(memoryPath) + sep)) {
          for (const pid of [ledger.data.childPid, ledger.data.pid]) if (pid) {
            if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
            else { try { process.kill(pid, "SIGTERM"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } }
          }
        }
      }
      if (process.platform === "win32" && proc.pid) spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
    }
    proc.stdin.end(); if (proc.exitCode === null) proc.kill(); await exit;
    server.stop(true);
    const ownedTemp = resolve(tmpdir()) + sep;
    if (!resolve(base).startsWith(ownedTemp) || !base.split(/[\\/]/).at(-1)?.startsWith("omo-mini-reflection-")) throw Error("Reflection fixture cleanup escaped owned temp directory");
    await rm(base, { recursive: true, force: true });
  }
}, 120000);
