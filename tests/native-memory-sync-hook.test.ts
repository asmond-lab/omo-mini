import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs, prepareProfile } from "../src/profile.ts";

const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 10_000 });
  expect(result.error, result.stderr).toBeUndefined();
  return result;
};

test("the complete shipped Native hook skips default Mini pushes and reaches a local mirror only after opt-in", async () => {
  const base = await mkdtemp(join(tmpdir(), "omo-mini-sync-hook-"));
  const root = join(base, "project"), work = join(base, "memory-repo"), bare = join(base, "mirror.git");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/api/v1/models"
    ? Response.json({ models: [{ key: "memory-local", type: "llm", capabilities: { trained_for_tool_use: true, vision: false },
      loaded_instances: [{ id: "memory-local", config: { context_length: 65536 } }] }] })
    : new Response("Not Found", { status: 404 }) });
  try {
    await mkdir(root);
    const args = ["rpc", "--root", root, "--state-dir", join(base, "state"), "--base-url", `http://127.0.0.1:${server.port}/v1`];
    const defaultProfile = await prepareProfile(parseArgs(args));
    const optInProfile = await prepareProfile(parseArgs([...args, "--native-memory-sync"]));
    const plugin = process.env["OMO_MINI_SYNC_HOOK_SOURCE"] ?? resolve(import.meta.dir, "..", "node_modules", "omo-ai", "plugin", "extensions", "omo.js");
    const source = await readFile(plugin, "utf8");
    const head = '{name:"post-commit",script:`';
    const start = source.indexOf(head);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("`}", start + head.length);
    expect(end).toBeGreaterThan(start);
    const keys = /var XN="([^"]+)",eR="([^"]+)",tR="([^"]+)"/.exec(source);
    expect(keys).not.toBeNull();
    const slash = String.fromCharCode(92), literalNewline = "__MINI_LITERAL_NEWLINE__";
    const hook = source.slice(start + head.length, end)
      .replaceAll("${XN}", keys![1]!).replaceAll("${eR}", keys![2]!).replaceAll("${tR}", keys![3]!)
      .replaceAll(`${slash}${slash}n`, literalNewline).replaceAll(`${slash}n`, "\n")
      .replaceAll(literalNewline, `${slash}n`);
    expect(hook).toContain("git push --quiet");
    expect(hook).toContain('if [ "$OMO_MEMORY_PUSH_SYNC" = "1" ]; then');
    const hookPath = join(base, "post-commit.sh");
    await writeFile(hookPath, hook);

    expect(run("git", ["init", "--quiet", "--bare", bare], root).status).toBe(0);
    expect(run("git", ["init", "--quiet", "--initial-branch=main", work], root).status).toBe(0);
    for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"], [keys![1]!, bare.replaceAll("\\", "/")]] as const)
      expect(run("git", ["-C", work, "config", "--local", key, value], root).status).toBe(0);
    await writeFile(join(work, "observed.txt"), "OBSERVED-LOCAL-419\n");
    expect(run("git", ["-C", work, "add", "observed.txt"], root).status).toBe(0);
    expect(run("git", ["-C", work, "commit", "--quiet", "-m", "observed fixture"], root).status).toBe(0);
    const headId = run("git", ["-C", work, "rev-parse", "HEAD"], root);
    expect(headId.status).toBe(0);
    const mirrorHead = () => run("git", ["-C", bare, "show-ref", "--verify", "--quiet", "refs/heads/main"], root).status;
    expect(mirrorHead()).toBe(1);

    // Native's own synchronous hook branch avoids a detached background push;
    // all Git writes stay in the two disposable local repositories above.
    const invoke = (env: NodeJS.ProcessEnv) => run("sh", [hookPath], work, { ...env, OMO_MEMORY_PUSH_SYNC: "1", GIT_TERMINAL_PROMPT: "0" });
    expect(invoke(defaultProfile.env).status).toBe(0);
    expect(mirrorHead()).toBe(1);
    const logPath = join(work, ".git", keys![2]!);
    expect(await Bun.file(logPath).exists()).toBe(false);

    expect(invoke(optInProfile.env).status).toBe(0);
    expect(mirrorHead()).toBe(0);
    expect(run("git", ["-C", bare, "rev-parse", "refs/heads/main"], root).stdout.trim()).toBe(headId.stdout.trim());
    expect(await readFile(logPath, "utf8")).toContain("exit=0");
  } finally {
    server.stop(true);
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep)) throw Error("Fixture escaped temporary directory");
    await rm(base, { recursive: true, force: true });
  }
}, 50_000);
