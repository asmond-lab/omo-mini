#!/usr/bin/env bun
/** Sequential real-model local-profile measurement on the public comparison corpus. */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const out = resolve(process.argv[2] ?? join(repo, "local-runtime.json"));
const scratch = await mkdtemp(join(tmpdir(), "omo-mini-runtime-"));
const fixture = join(scratch, "fixture");
const modelUrl = "http://127.0.0.1:1234";
const selected = (await (await fetch(`${modelUrl}/api/v0/models`, { signal: AbortSignal.timeout(8000) })).json()).data.filter((m: any) => m.state === "loaded" && m.capabilities?.includes("tool_use"));
if (selected.length !== 1 || selected[0].type !== "vlm") throw new Error("Expected one loaded tool-capable VLM");
const tasks = (await readFile(join(repo, "benchmarks/corpus/tasks.json"), "utf8").then(JSON.parse)).tasks as { id: string; question: string }[];
let bytes: number[] = [];
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.arrayBuffer() : undefined;
  if (url.pathname.includes("chat/completions") && body) bytes.push(body.byteLength);
  const headers = new Headers(req.headers); headers.delete("host");
  const response = await fetch(`${modelUrl}${url.pathname}${url.search}`, { method: req.method, headers, body, signal: req.signal });
  return new Response(response.body, { status: response.status, headers: response.headers });
} });
try {
  await cp(join(repo, "benchmarks/corpus/fixtures/tidewatch"), fixture, { recursive: true });
  await writeFile(join(fixture, "assets/status.png"), Buffer.from((await readFile(join(fixture, "assets/status.png.b64"), "utf8")).trim(), "base64"));
  const rows = [];
  for (const id of (process.argv[3] ? [process.argv[3]] : ["T01", "T07", "T09", "T12"])) {
    bytes = [];
    const task = tasks.find(item => item.id === id)!;
    const question = id === "T12" ? "Look at the attached PNG image. What are the colors of its top-left and top-right pixels? Do not infer colors from base64 text." : task.question;
    const args = [join(repo, "dist/cli.js"), "run", "--root", fixture, "--state-dir", join(scratch, `state-${id}`), "--task", question, "--model", selected[0].id, "--base-url", `http://127.0.0.1:${proxy.port}/v1`, "--permission", "read-only", "--json"];
    if (id === "T12") args.push("--image", "assets/status.png");
    const start = performance.now();
    const child = Bun.spawn([process.execPath, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 120000);
    let exit: number, stdout: string, stderr: string;
    try { [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
    finally { clearTimeout(timeout); }
    const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const assistants = events.filter(event => event.type === "message_end" && event.message?.role === "assistant").map(event => event.message);
    const last = assistants.at(-1);
    const answer = (last?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    const status = events.find(event => event.type === "omo_mini_status");
    const row = { id, exit, wallMs: Math.round(performance.now() - start), requestBytes: [...bytes], requests: bytes.length,
      toolCalls: events.filter(event => event.type === "tool_execution_end").length,
      invalidCalls: events.filter(event => event.type === "tool_execution_end" && event.isError).length,
      stopReason: last?.stopReason ?? "missing", status: status?.error ?? null, answer: answer.slice(0, 2000).replaceAll(scratch, "<temporary>").replaceAll(scratch.replaceAll("\\", "/"), "<temporary>"),
      usage: { input: assistants.reduce((sum: number, message: any) => sum + (message.usage?.input ?? 0), 0), output: assistants.reduce((sum: number, message: any) => sum + (message.usage?.output ?? 0), 0) }, stderrTail: stderr.slice(-500).replaceAll(scratch, "<temporary>") };
    rows.push(row);
    console.log(`${id}: exit=${exit} reason=${row.stopReason} requests=${row.requests} invalid=${row.invalidCalls} wall=${row.wallMs}ms`);
  }
  await writeFile(out, JSON.stringify({ model: selected[0].id, loadedContext: selected[0].loaded_context_length, cases: rows, timeoutMs: 120000 }, null, 2) + "\n");
} finally { proxy.stop(true); await rm(scratch, { recursive: true, force: true }); }
