#!/usr/bin/env bun
/** Sequential, disposable comparison of historical v0.1 and native OmO on public fixtures.
 * Run: bun benchmarks/native-comparison.ts [output.json]
 * Requires local LM Studio on 127.0.0.1:1234 and an already built native dist/cli.js.
 * Never stores raw tool transcripts or session logs in the output artifact.
 */
import { cp, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? join(repo, "native-comparison.json"));
const scratch = await mkdtemp(join(tmpdir(), "omo-native-compare-"));
const baseline = join(scratch, "historical");
const fixture = join(scratch, "fixture");
const state = join(scratch, "native-state");
const corpus = join(repo, "benchmarks", "corpus");
const modelUrl = "http://127.0.0.1:1234";
const modelBefore = await (await fetch(`${modelUrl}/api/v0/models`, { signal: AbortSignal.timeout(8000) })).json();
const selected = modelBefore.data.filter((m: any) => m.state === "loaded" && m.capabilities?.includes("tool_use"));
if (selected.length !== 1 || !selected[0].loaded_context_length || selected[0].type !== "vlm") throw new Error("Expected one loaded tool-capable VLM");
const model = selected[0].id as string;
const context = selected[0].loaded_context_length as number;
const tasks = (await readFile(join(corpus, "tasks.json"), "utf8").then(JSON.parse)).tasks as { id: string; question: string }[];
const ids = ["T01", "T07", "T09", "T12"];
const sampled = ids.map(id => tasks.find(t => t.id === id)!);
const oracle = await readFile(join(corpus, "oracle", "answers.json"), "utf8").then(JSON.parse);
let requestBytes: number[] = [];
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  const body = req.method === "POST" ? await req.arrayBuffer() : undefined;
  if (path.includes("chat/completions") && body) requestBytes.push(body.byteLength);
  const headers = new Headers(req.headers);
  headers.delete("host");
  const response = await fetch(`${modelUrl}${path}`, { method: req.method, headers, body, signal: req.signal });
  return new Response(response.body, { status: response.status, headers: response.headers });
} });
const baseUrl = `http://127.0.0.1:${proxy.port}/v1`;
let worktreeAdded = false;
async function command(args: string[], cwd: string, timeoutMs: number) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function invoke(args: string[], cwd: string, timeoutMs = 120000) {
  requestBytes = [];
  const start = performance.now();
  const result = await command([process.execPath, ...args], cwd, timeoutMs);
  return { ...result, wallMs: Math.round(performance.now() - start), requestBytes: [...requestBytes] };
}
function grade(id: string, answer: string) {
  if (id === "T09") return /(?:not found|no (?:such|pagerduty|integration)|couldn't find|does not contain|did not find)/i.test(answer) && !/(?:integration|api|pagerduty)_key\s*[:=]\s*[^\s]+/i.test(answer);
  if (id === "T07") return /src\/dispatcher\.py/i.test(answer.replaceAll("\\", "/")) && /len\(events\)/i.test(answer) && /(?:archived|archive)[\s\S]*(?:\b1\b|single|one)[\s\S]*(?:batch|deliver|nonempty|event)/i.test(answer);
  if (id === "T12") return /(?:top.left[\s\S]*red[\s\S]*top.right[\s\S]*blue|red[\s\S]*blue)/i.test(answer);
  return oracle[id].values.every((value: string) => answer.toLowerCase().includes(value.toLowerCase()));
}
function nativeEvents(raw: string) {
  return raw.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function summarizeNative(raw: string) {
  const events = nativeEvents(raw);
  const assistant = events.filter(e => e.type === "message_end" && e.message?.role === "assistant").map(e => e.message);
  const terminal = events.filter(e => e.type === "agent_end").at(-1);
  const messages = assistant.length ? assistant : terminal?.messages?.filter((m: any) => m.role === "assistant") ?? [];
  const last = messages.at(-1);
  const answer = (last?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const tools = events.filter(e => e.type === "tool_execution_end");
  return { answer, reason: last?.stopReason ?? "missing", calls: tools.length,
    invalidCalls: tools.filter(e => e.isError).length, requests: messages.length,
    usage: messages.length ? { input: messages.reduce((n: number, m: any) => n + (m.usage?.input ?? 0), 0), output: messages.reduce((n: number, m: any) => n + (m.usage?.output ?? 0), 0) } : null,
    status: events.find(e => e.type === "omo_mini_status")?.error?.code ?? null };
}
try {
  const added = await command(["git", "worktree", "add", "--detach", baseline, "ed86f395"], repo, 20000);
  if (added.exit !== 0) throw new Error(`Worktree add failed: ${added.stderr}`);
  worktreeAdded = true;
  await symlink(join(repo, "node_modules"), join(baseline, "node_modules"), "junction");
  const built = await command([process.execPath, "build", "./src/cli.ts", "--target", "bun", "--outfile", "./dist/cli.js"], baseline, 30000);
  if (built.exit !== 0) throw new Error(`Baseline build failed: ${built.stderr}`);
  await cp(join(corpus, "fixtures", "tidewatch"), fixture, { recursive: true });
  const image = Buffer.from((await readFile(join(fixture, "assets", "status.png.b64"), "utf8")).trim(), "base64");
  await writeFile(join(fixture, "assets", "status.png"), image);
  const rows = [];
  for (const task of sampled) {
    for (const profile of ["legacy", "native"] as const) {
      const vision = task.id === "T12";
      const question = vision ? "Look at the attached PNG image. What are the colors of its top-left and top-right pixels? Do not infer colors from base64 text." : task.question;
      const args = profile === "legacy" ? ["dist/cli.js", "run", "--root", fixture, "--task", question, "--strategy", "baseline", "--model", model, "--base-url", baseUrl, "--json"] :
        [join(repo, "dist", "cli.js"), "run", "--root", fixture, "--state-dir", join(state, task.id), "--task", question, "--model", model, "--base-url", baseUrl, "--permission", "read-only", "--json"];
      if (vision) args.push("--image", "assets/status.png");
      const result = await invoke(args, profile === "legacy" ? baseline : repo);
      const parsed = profile === "legacy" ? (() => { try { return JSON.parse(result.stdout); } catch { return {}; } })() : summarizeNative(result.stdout);
      const answer = parsed.answer ?? "";
      const row = { id: task.id, profile, exit: result.exit, reason: parsed.reason ?? "missing", correct: result.exit === 0 && parsed.reason === "stop" && grade(task.id, answer),
        answer: answer.slice(0, 2000).replaceAll(scratch.replaceAll("\\", "/"), "<temporary>").replaceAll(scratch, "<temporary>"),
        calls: profile === "legacy" ? parsed.tools?.length ?? 0 : parsed.reason === "missing" ? null : parsed.calls, invalidCalls: profile === "legacy" ? parsed.tools?.filter((t: any) => t.isError).length ?? 0 : parsed.reason === "missing" ? null : parsed.invalidCalls,
        requests: result.requestBytes.length, usage: parsed.usage ?? null, wallMs: result.wallMs,
        requestBytes: result.requestBytes, errorCode: parsed.status ?? parsed.error?.code ?? null };
      rows.push(row);
      console.log(`${task.id} ${profile}: ${row.exit}/${row.reason} correct=${row.correct} calls=${row.calls} requests=${row.requestBytes.length} ${row.wallMs}ms`);
    }
  }
  // Native-only disposable coding exercise. No code or test inside the benchmark root is modified.
  const coding = join(scratch, "coding");
  await mkdir(join(coding, "src"), { recursive: true });
  await writeFile(join(coding, "src", "double.ts"), "export function double(n: number): number { return n + n + 1; }\n");
  await writeFile(join(coding, "src", "double.test.ts"), "import { test, expect } from 'bun:test';\nimport { double } from './double';\ntest('doubles', () => { expect(double(2)).toBe(4); expect(double(-3)).toBe(-6); });\n");
  const codingTask = "Fix src/double.ts so double(n) returns exactly twice n. Run bun test src/double.test.ts and report the result. Make no other changes.";
  const codeRun = await invoke([join(repo, "dist", "cli.js"), "run", "--root", coding, "--state-dir", join(state, "coding"), "--task", codingTask, "--model", model, "--base-url", baseUrl, "--json"], repo);
  const codeEvents = summarizeNative(codeRun.stdout);
  const diff = await command(["git", "diff", "--no-index", "--", "NUL", join(coding, "src", "double.ts")], repo, 5000);
  const test = await command([process.execPath, "test", "src/double.test.ts"], coding, 30000);
  const source = await readFile(join(coding, "src", "double.ts"), "utf8");
  const result = { version: 1, baselineCommit: "ed86f395", nativeCommit: (await command(["git", "rev-parse", "HEAD"], repo, 5000)).stdout.trim(), model, loadedContext: context,
    taskIds: ids, order: "one sequential run per case, legacy then native, no retries", timeoutMs: 120000,
    units: { wallMs: "CLI process elapsed, includes setup", requestBytes: "actual outbound chat/completions HTTP body bytes (excluding listing and HTTP headers)", usage: "reported provider token usage, not independently tokenized" },
    rows, coding: { profile: "native only", legacy: "unsupported: v0.1 tools are read-only; not run as an edit agent", exit: codeRun.exit, reason: codeEvents.reason,
      calls: codeEvents.calls, invalidCalls: codeEvents.invalidCalls, usage: codeEvents.usage, wallMs: codeRun.wallMs, requestBytes: codeRun.requestBytes,
      changed: source !== "export function double(n: number): number { return n + n + 1; }\n", finalSource: source, testExit: test.exit,
      diffObserved: diff.exit === 1 && diff.stdout.includes("double.ts") },
    modelAfter: (await (await fetch(`${modelUrl}/api/v0/models`, { signal: AbortSignal.timeout(8000) })).json()).data.filter((m: any) => m.state === "loaded").map((m: any) => ({ id: m.id, loadedContext: m.loaded_context_length })) };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote ${output}`);
} finally {
  proxy.stop(true);
  if (worktreeAdded) {
    // Remove the junction before git's recursive worktree removal: never traverse shared dependencies.
    await rmdir(join(baseline, "node_modules"));
    const removed = await command(["git", "worktree", "remove", "--force", baseline], repo, 30000);
    if (removed.exit !== 0) console.error(`Worktree cleanup failed: ${removed.stderr}`);
  }
  try { await rm(scratch, { recursive: true, force: true }); }
  catch (error) { console.error(`Disposable cleanup incomplete at ${scratch}: ${error}`); }
}
