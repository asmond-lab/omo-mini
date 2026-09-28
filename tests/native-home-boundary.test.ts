import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

type Frame = { type: string; id?: string; method?: string; toolCallId?: string; isError?: boolean };
type Run = { exit: Promise<number | null>; ended: Promise<Frame>; taskEnd: Promise<Frame>; wire: string[]; stderr: () => string; stop: () => Promise<void> };

const HOME_MARKERS = ["HOME-CATEGORY-9303", "HOME-FOOTER-9302"];
const PROJECT_MARKER = "PROJECT-CATEGORY-9304";
// The real user's global config as seen from a Mini workspace below it: a memory
// override Mini must never load, markers for both Native loaders (omo.js category
// catalog, omo-task.js git-master footer), and a model id Native migration rewrites.
const HOME_CONFIG = `{
  "memory": { "enabled": true, "agent": "home-agent" },
  "git_master": { "commit_footer": "${HOME_MARKERS[1]}" },
  "categories": { "deep": { "model": "openai-codex/gpt-5", "description": "${HOME_MARKERS[0]}" } }
}
`;

async function withHome(project: object, check: (run: Run, home: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "omo-mini-home-boundary-"));
  const home = join(base, "home"), cwd = join(home, "work", "app");
  await mkdir(join(home, ".omo"), { recursive: true });
  await mkdir(join(home, "work", ".omo"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(home, ".omo", "omo.jsonc"), HOME_CONFIG);
  await writeFile(join(home, "work", ".omo", "omo.json"), JSON.stringify(project));
  const spelled = process.platform === "win32" ? `${home.toLowerCase()}${sep}` : `${home}/`;
  const wire: string[] = [];
  const sse = (delta: object, finish: string) => [delta, {}].map((part, index) => `data: ${JSON.stringify({ id: "home", object: "chat.completion.chunk",
    choices: [{ index: 0, delta: part, finish_reason: index ? finish : null }] })}\n\n`).join("") + "data: [DONE]\n\n";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/models") return Response.json({ models: [{ key: "home-local", type: "llm", capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "home-local", config: { context_length: 65536 } }] }] });
    if (path !== "/v1/chat/completions") return new Response("Not Found", { status: 404 });
    const body = await request.text();
    wire.push(body);
    // Parent delegates one quick task that loads git-master (omo-task.js config path), then finishes.
    const delta = body.includes("\"tool_call_id\":\"task-1\"") ? { content: "Done." } : body.includes("CHILD-ASK-51") ? { content: "CHILD-DONE-51" }
      : { tool_calls: [{ index: 0, id: "task-1", type: "function", function: { name: "task", arguments: JSON.stringify({ category: "quick",
          task_summary: "Home boundary child", prompt: "Reply CHILD-ASK-51.", load_skills: ["git-master"], run_in_background: false }) } }] };
    return new Response(sse(delta, "tool_calls" in delta ? "tool_calls" : "stop"), { headers: { "content-type": "text/event-stream" } });
  } });
  const child = spawn(process.execPath, ["src/cli.ts", "rpc", "--root", cwd, "--state-dir", join(base, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`],
    // Windows compares paths case-insensitively; a lower-case, slash-terminated home must still be the boundary.
    { cwd: resolve(import.meta.dir, ".."), env: { ...process.env, HOME: spelled, USERPROFILE: spelled }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "", buffer = "";
  const listeners = new Set<(frame: Frame) => void>();
  const exit = new Promise<number | null>(accept => child.once("exit", code => accept(code)));
  const wait = (match: (frame: Frame) => boolean) => {
    const frame = new Promise<Frame>((accept, reject) => {
      const done = () => { clearTimeout(timer); listeners.delete(onFrame); };
      const onFrame = (next: Frame) => { if (match(next)) { done(); accept(next); } };
      const timer = setTimeout(() => { done(); reject(new Error(`Native home-boundary deadline: ${stderr.slice(-900)}`)); }, 90000);
      listeners.add(onFrame);
      void exit.then(code => { done(); reject(new Error(`Native exited ${code}: ${stderr.slice(-900)}`)); });
    });
    void frame.catch(() => {});
    return frame;
  };
  // A refused launch closes stdin before the prompt lands; keep that as diagnostic context.
  child.stdin.on("error", (error: Error) => { stderr += `\n[stdin] ${error.message}`; });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line.startsWith("{")) continue;
      const frame = JSON.parse(line) as Frame;
      if (frame.type === "extension_ui_request" && frame.method === "select")
        child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Allow once" }) + "\n");
      for (const listener of listeners) listener(frame);
    }
  });
  const run: Run = { exit, wire, stderr: () => stderr,
    ended: wait(frame => frame.type === "agent_end"), taskEnd: wait(frame => frame.type === "tool_execution_end" && frame.toolCallId === "task-1"),
    stop: async () => {
      if (child.exitCode !== null) return;
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdin.end(); child.kill(); await exit; clearTimeout(timer);
    } };
  let primary: unknown;
  try {
    child.stdin.write(JSON.stringify({ id: "1", type: "prompt", message: "Delegate a quick task." }) + "\n");
    await check(run, home);
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  for (const step of [run.stop, async () => server.stop(true), () => rm(base, { recursive: true, force: true })])
    await step().catch((error: unknown) => { cleanup.push(error); });
  if (primary !== undefined && cleanup.length) throw new AggregateError([primary, ...cleanup], "Native home-boundary test and cleanup failed");
  if (primary !== undefined) throw primary;
  if (cleanup.length) throw new AggregateError(cleanup, "Native home-boundary cleanup failed");
}

test("Native under the real home does not load or migrate the home config as a project layer", async () =>
  withHome({ categories: { writing: { description: PROJECT_MARKER } } }, async (run, home) => {
    expect((await run.taskEnd).isError).toBe(false);
    await run.ended;
    const requests = (marker: string) => run.wire.flatMap((body, index) => body.includes(marker) ? [index] : []);
    // One comparison so a regression reports the leak, the migration and the project layer together.
    expect({
      child: requests("CHILD-ASK-51").length > 0,
      homeMarkers: Object.fromEntries(HOME_MARKERS.map(marker => [marker, requests(marker)])),
      projectLayer: requests(PROJECT_MARKER).length > 0, // the genuine project layer between cwd and home is still merged
      homeConfigUnchanged: await readFile(join(home, ".omo", "omo.jsonc"), "utf8") === HOME_CONFIG,
      homeOmoExtras: (await readdir(join(home, ".omo"))).filter(name => name !== "omo.jsonc"),
    }).toEqual({ child: true, homeMarkers: Object.fromEntries(HOME_MARKERS.map(marker => [marker, []])), projectLayer: true,
      homeConfigUnchanged: true, homeOmoExtras: [] });
  }), 180000);

test("an unsafe project memory override between cwd and home is still refused", async () =>
  withHome({ memory: { agent: "project-agent" } }, async run => {
    expect(await run.exit).toBe(1);
    expect(run.stderr().split(":")[0]).toBe("config");
    expect(run.stderr()).toContain(join("work", ".omo", "omo.json"));
    expect(run.wire).toEqual([]);
  }), 60000);
