import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, prepareProfile } from "../src/profile.ts";

type Frame = { type: string; id?: string; success?: boolean; data?: { disposition?: string; sessionFile?: string; summary?: string }; method?: string; message?: string; toolName?: string; toolCallId?: string; isError?: boolean; willRetry?: boolean };
type Wire = { messages: { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string } }[]; tool_call_id?: string }[]; tools?: { function: { name: string } }[] };
const model = "native-memory-local";
const fact = "PUBLIC-APPROVED-CEDAR-741";
const task = "Read the public fixture and report its result";
const next = "Next action: inspect public-next.txt before claiming completion";
const tool = (name: string, input: unknown, id: number) => ({ tool_calls: [{ index: 0, id: `memory-call-${id}`, type: "function", function: { name, arguments: JSON.stringify(input) } }] });

test("native committed memory, goal/todo and verified work survive compaction and selected resume, not /new or another root", async () => {
  const base = await mkdtemp(join(tmpdir(), "omo-mini-native-memory-"));
  const state = join(base, "state"), a = join(base, "project-a"), b = join(base, "project-b");
  await Promise.all([mkdir(a), mkdir(b)]);
  await Bun.write(join(a, "public.txt"), "PUBLIC-RESULT-831\n");
  const requests: Wire[] = []; const capturedFrames: Frame[] = [], unknownPaths: string[] = []; let callId = 0;
  const sequence = new Map<string, number>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v0/models") return Response.json({ data: [{ id: model, state: "loaded", type: "llm", loaded_context_length: 69376, capabilities: ["tool_use"] }] });
    if (path !== "/v1/chat/completions") { unknownPaths.push(path); return new Response("not found", { status: 404 }); }
    const wire = await request.json() as Wire; requests.push(wire);
    const history = JSON.stringify(wire.messages);
    const summarizing = !wire.tools?.length;
    const key = history.includes("Forget approved fact") ? "forget" : history.includes("Work on fixture") ? "work"
      : history.includes("Guard interaction") ? "guard" : history.includes("Approved fact") ? "fact" : "reply";
    const step = sequence.get(key) ?? 0; sequence.set(key, step + 1);
    let delta: Record<string, unknown> = { content: summarizing ? `## Goal\nComplete ${task}.\n## Progress\nRead public.txt; observed PUBLIC-RESULT-831 from successful native read.\n## Next Steps\n${next}` : "ACK" };
    if (!summarizing && key === "fact" && step === 0) delta = tool("memory", { command: "create", reason: "User approved project fact", file_path: "system/project.md", description: "Approved public project identifier", file_text: fact }, ++callId);
    if (!summarizing && key === "forget" && step === 0) delta = tool("memory", { command: "delete", reason: "User explicitly requested forget", file_path: "system/project.md" }, ++callId);
    if (!summarizing && key === "guard") {
      const fail = { command: `bun -e "require('fs').appendFileSync('failed.txt','x');process.exit(49)"` };
      const steps = [
        () => tool("bash", fail, ++callId),
        () => tool("todo", { op: "view" }, ++callId),
        () => tool("memory", { command: "create", reason: "Approved guard fixture fact", file_path: "external/guard.md", description: "Public fixture", file_text: "GUARD-APPROVED" }, ++callId),
        () => tool("bash", fail, ++callId),
      ];
      if (step < steps.length) delta = steps[step]!();
    }
    if (!summarizing && key === "work") {
      const steps = [
        () => tool("create_goal", { objective: `Complete ${task}; ${next}` }, ++callId),
        () => tool("todo", { op: "init", items: [task, next] }, ++callId),
        () => tool("read", { path: "public.txt" }, ++callId),
        () => tool("todo", { op: "done", task }, ++callId),
      ];
      if (step < steps.length) delta = steps[step]!();
    }
    if (!summarizing && !history.includes("PUBLIC-RESULT-831") && key === "work" && step > 2) throw Error("Missing observed action result");
    const finish = "tool_calls" in delta ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: "memory-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "memory-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  function start(root: string) {
    const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", root, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`], { cwd: resolve(import.meta.dir, ".."), stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", errors = ""; const frames: Frame[] = [], listeners = new Set<(frame: Frame) => void>();
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString(); let index;
      while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line.startsWith("{")) { const frame = JSON.parse(line) as Frame; frames.push(frame); capturedFrames.push(frame); for (const listener of listeners) listener(frame); }
      }
    });
    const wait = (match: (frame: Frame) => boolean) => new Promise<Frame>((accept, reject) => {
      const listener = (frame: Frame) => { if (match(frame)) { clearTimeout(timer); listeners.delete(listener); accept(frame); } };
      const timer = setTimeout(() => { listeners.delete(listener); reject(Error(`native RPC timeout: ${errors.slice(-1200)} frames=${JSON.stringify(frames.slice(-8))} requests=${requests.length}`)); }, 60000);
      listeners.add(listener);
    });
    let nextId = 0;
    async function send(type: string, data: Record<string, unknown> = {}, idle = false) {
      const id = String(++nextId), ack = wait(frame => frame.type === "response" && frame.id === id);
      let ended = false;
      const end = idle ? wait(frame => frame.type === "agent_end" && !frame.willRetry && (ended = true)) : undefined;
      const done = idle ? wait(frame => ended && frame.type === "agent_idle") : undefined;
      child.stdin.write(JSON.stringify({ type, id, ...data }) + "\n");
      const result = await ack; if (end) await end; if (done) await done;
      expect(result.success, `${type}: ${errors.slice(-1200)} ${JSON.stringify(result)}`).toBe(true);
      return result;
    }
    async function close() {
      if (child.exitCode !== null) return;
      const exit = new Promise<void>((accept, reject) => { const timer = setTimeout(() => { child.kill(); reject(Error("RPC graceful exit timeout")); }, 10000); child.once("exit", () => { clearTimeout(timer); accept(); }); });
      child.stdin.end(); await exit;
    }
    return { send, frames, close };
  }
  let rpc = start(a);
  try {
    const init = await rpc.send("prompt", { message: "/memfs init" }); expect(init.data?.disposition).toBe("handled");
    expect(rpc.frames.some(frame => frame.method === "notify" && frame.message?.includes("initialized memory repository"))).toBe(true);
    await rpc.send("prompt", { message: "/memfs status" });
    expect(rpc.frames.some(frame => frame.message?.includes("Mirror: not configured"))).toBe(true);
    const identity = (await readdir(join(state, "memory", "agents")))[0]!;
    const repo = join(state, "memory", "agents", identity, "repo");
    expect(execFileSync("git", ["-C", repo, "remote", "-v"], { encoding: "utf8" })).toBe("");
    // Even a manually added remote cannot turn locally committed memory into a push.
    execFileSync("git", ["-C", repo, "remote", "add", "origin", `http://127.0.0.1:${server.port}/forbidden-git-remote`]);
    const saved = (await rpc.send("get_state")).data?.sessionFile; expect(saved).toBeTruthy();
    await rpc.send("prompt", { message: `Approved fact for this project only: ${fact}. Save it as durable memory.` }, true);
    expect((await readFile(join(repo, "system", "project.md"), "utf8"))).toContain(fact);
    const committedMemory = await readFile(join(repo, "system", "project.md"), "utf8");
    const committedHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    expect(unknownPaths).toEqual([]);
    execFileSync("git", ["-C", repo, "remote", "remove", "origin"]);
    await rpc.send("prompt", { message: "Guard interaction: execute the failing action, inspect todo, commit the approved guard fixture fact, and attempt the identical failing action." }, true);
    expect(await readFile(join(a, "failed.txt"), "utf8")).toBe("x");
    const guardWire = requests.at(-1)!.messages;
    expect(guardWire.filter(item => item.role === "tool").map(item => item.tool_call_id))
      .toEqual(guardWire.flatMap(item => item.tool_calls?.map(call => call.id) ?? []));
    expect(JSON.stringify(guardWire)).toContain("Repeated failed tool action blocked before execution");
    await rpc.send("prompt", { message: `Work on fixture: ${task}. Keep ${next}.` }, true);
    const worked = requests.at(-1)!;
    expect(JSON.stringify(worked.messages)).toContain("PUBLIC-RESULT-831");
    expect(JSON.stringify(worked.messages)).toContain(next);
    expect(worked.messages.filter(item => item.role === "tool").map(item => item.tool_call_id))
      .toEqual(worked.messages.flatMap(item => item.tool_calls?.map(call => call.id) ?? []));
    await rpc.send("prompt", { message: `Disposable compaction padding (not durable memory): ${"public padding ".repeat(1300)}` }, true);
    const compact = await rpc.send("compact");
    expect(compact.data?.summary).toBeTruthy();
    await rpc.send("prompt", { message: "Continue selected work after compaction." }, true);
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain(next);
    const fresh = await rpc.send("new_session"); expect(fresh.success).toBe(true);
    await rpc.send("prompt", { message: "Fresh conversation: answer ACK." }, true);
    const newWire = JSON.stringify(requests.at(-1));
    expect(newWire).toContain(fact); expect(newWire).not.toContain(task); expect(newWire).not.toContain("PUBLIC-RESULT-831");
    await rpc.close();
    rpc = start(a);
    await rpc.send("switch_session", { sessionPath: saved });
    const beforeResume = requests.length;
    await rpc.send("prompt", { message: "Resume selected ongoing task. What was observed and what remains?" }, true);
    const resumed = JSON.stringify(requests.slice(beforeResume).map(wire => wire.messages));
    await rpc.send("prompt", { message: "/memory" });
    expect(rpc.frames.filter(frame => frame.method === "notify").map(frame => frame.message).join(" ")).toContain(fact);
    expect(resumed).toContain(next); expect(resumed.includes("PUBLIC-RESULT-831"), `checkpoint missing in ${requests.length - beforeResume} resumed requests; entry count ${rpc.frames.filter(frame => frame.type === "entry_appended").length}`).toBe(true);
    await rpc.send("prompt", { message: "Forget approved fact: remove the project identifier from native memory." }, true);
    await expect(readFile(join(repo, "system", "project.md"), "utf8")).rejects.toThrow();
    await rpc.send("new_session");
    await rpc.send("prompt", { message: "After forgetting, answer ACK." }, true);
    expect(JSON.stringify(requests.at(-1))).not.toContain(fact);
    await rpc.close(); rpc = start(b);
    await rpc.send("prompt", { message: "New project, answer ACK." }, true);
    const other = JSON.stringify(requests.at(-1)); expect(other).not.toContain(fact); expect(other).not.toContain(task);
    expect((await readdir(join(state, "memory", "agents"))).length).toBe(2);
    await rpc.send("prompt", { message: "/memory" });
    expect(rpc.frames.filter(frame => frame.method === "notify").map(frame => frame.message).join(" ")).toContain("/memfs init");
    await rpc.send("prompt", { message: "/memfs init" });
    const identityB = (await readdir(join(state, "memory", "agents"))).find(name => name !== identity)!;
    const repoB = join(state, "memory", "agents", identityB, "repo");
    await rename(join(repoB, ".git"), join(repoB, ".git-broken"));
    await rpc.send("prompt", { message: "/memory" });
    expect(rpc.frames.filter(frame => frame.method === "notify").map(frame => frame.message).at(-1)).toContain("/memfs init");
    await rpc.close();
    const entries = (await readFile(saved!, "utf8")).trim().split(/\r?\n/);
    if (process.env["OMO_MEMORY_EVIDENCE_DIR"]) await Bun.write(join(process.env["OMO_MEMORY_EVIDENCE_DIR"], "native-memory-session.jsonl"), entries.join("\n") + "\n");
    const lastEntry = JSON.parse(entries.at(-1)!) as { id: string };
    await appendFile(saved!, JSON.stringify({ type: "custom", id: "invalid-mini-checkpoint", parentId: lastEntry.id,
      timestamp: new Date().toISOString(), customType: "omo-mini.work-checkpoint",
      data: { version: 1, root: a, observed: { id: "x", tool: "read", result: "x".repeat(8000) } } }) + "\n");
    rpc = start(a);
    await rpc.send("switch_session", { sessionPath: saved });
    const beforeInvalid = requests.length;
    await rpc.send("prompt", { message: "Continue after malformed checkpoint." }, true);
    expect(requests.length).toBeGreaterThan(beforeInvalid); // A derived cache must not deadlock the conversation.
    const recoveredWire = JSON.stringify(requests.slice(beforeInvalid));
    expect(recoveredWire).not.toContain("x".repeat(8000));
    expect(recoveredWire).not.toContain("<session_work_checkpoint>");
    expect(rpc.frames.some(frame => frame.method === "notify" && frame.message?.includes("Invalid local work checkpoint"))).toBe(true);
    const c = join(base, "project-config-override");
    await mkdir(join(c, ".omo"), { recursive: true });
    await Bun.write(join(c, ".omo", "omo.json"), JSON.stringify({ memory: { sync: { enabled: true, remote: `http://127.0.0.1:${server.port}/forbidden` } } }));
    const configOptions = parseArgs(["rpc", "--root", c, "--state-dir", state, "--base-url", `http://127.0.0.1:${server.port}/v1`]);
    await expect(prepareProfile(configOptions)).rejects.toThrow("Project OmO memory override would break");
    await Bun.write(join(c, ".omo", "omo.json"), JSON.stringify({ "[native]": { memory: { agent: identity } } }));
    await expect(prepareProfile(configOptions)).rejects.toThrow("Project OmO memory override would break");
    await Bun.write(join(c, ".omo", "omo.json"), JSON.stringify({ memory: { enabled: true, sync: { enabled: false } }, categories: {} }));
    expect((await prepareProfile(configOptions)).root).toBe(c);
    expect(unknownPaths).toEqual([]);
    expect(requests[0]!.tools?.map(item => item.function.name)).toEqual(["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "memory", "create_goal", "update_goal", "get_goal", "todo"]);
    expect(Buffer.byteLength(String(requests[0]!.messages[0]?.content))).toBeLessThan(8000);
    if (process.env["OMO_MEMORY_EVIDENCE_DIR"]) {
      const directory = process.env["OMO_MEMORY_EVIDENCE_DIR"];
      await Promise.all([
        Bun.write(join(directory, "native-memory-wire.json"), JSON.stringify({ identity, config: JSON.parse(await readFile(join(state, "home", ".omo", "omo.json"), "utf8")), tools: requests[0]?.tools?.map(item => item.function.name), systemPromptBytes: Buffer.byteLength(String(requests[0]?.messages[0]?.content)), requestCount: requests.length, selectedSession: saved, compactionSummary: compact.data?.summary, workPairs: worked.messages.filter(item => item.role === "tool").map(item => item.tool_call_id), resumedIncludesResult: resumed.includes("PUBLIC-RESULT-831"), newIncludesFact: newWire.includes(fact), otherProjectIsolated: !other.includes(fact), unknownPaths }, null, 2)),
        Bun.write(join(directory, "native-memory-raw-wire.json"), JSON.stringify(requests, null, 2)),
        Bun.write(join(directory, "native-memory-rpc.json"), JSON.stringify(capturedFrames, null, 2)),
        Bun.write(join(directory, "native-memory-repository.json"), JSON.stringify({ identity, committedHead, committedMemory, finalHead: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), remotes: execFileSync("git", ["-C", repo, "remote", "-v"], { encoding: "utf8" }), projectBIdentity: identityB, unknownPaths }, null, 2)),
      ]);
    }
  } finally { await rpc.close(); server.stop(true); await rm(base, { recursive: true, force: true }); }
}, 300000);
