import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { prepareReflectionLaunch } from "../src/reflection-supervisor.ts";

test("reflection adapter preserves Native lifecycle fields and changes only the tool route", async () => {
  const home = await mkdtemp(join(tmpdir(), "omo-mini-reflection-supervisor-"));
  const run = join(home, "agents", "fixture", "runtime", "reflection", "runs", "reflection-run-1");
  const worktree = join(home, "agents", "fixture", "runtime", "worktrees", "fixture-run-1");
  await mkdir(run, { recursive: true }); await mkdir(worktree, { recursive: true });
  const launchPath = join(run, "launch.json");
  const launch = { version: 1, kind: "reflection", runId: "reflection-run-1", cwd: worktree,
    args: ["native.js", "-p", "--tools", "bash,edit", "--no-extensions", "@task.md"],
    env: { MEMORY_DIR: worktree, OMO_MINI_LOCAL_PROFILE: "1", SENPI_MEMORY_REFLECTION: "1" },
    hardDeadlineAt: 1234567, attempt: 1, command: "bun", stdoutPath: "native-stdout", stderrPath: "native-stderr",
    terminationGraceMs: 5000, maxOutputBytes: 65536 };
  try {
    await writeFile(launchPath, JSON.stringify(launch));
    await prepareReflectionLaunch(run, { memoryHome: home, extensionPath: "owned-extension.ts" });
    const changed = JSON.parse(await readFile(launchPath, "utf8"));
    expect(changed).toEqual({ ...launch, args: ["native.js", "-p", "--tools",
      "read,grep,find,ls,edit,write,reflection_input,reflection_commit", "--no-extensions",
      "--extension", "owned-extension.ts", "--permission", "reflection_input=allow,reflection_commit=allow", "@task.md"] });
    // A Native contract change must fail visibly rather than run an unguarded worker.
    await expect(prepareReflectionLaunch(run, { memoryHome: home, extensionPath: "owned-extension.ts" })).rejects.toThrow("Unexpected Native");
    const dream = { ...launch, kind: "dream" };
    await writeFile(launchPath, JSON.stringify(dream));
    await prepareReflectionLaunch(run, { memoryHome: home, extensionPath: "owned-extension.ts" });
    expect(JSON.parse(await readFile(launchPath, "utf8"))).toEqual(dream);
    const original = { ...launch, cwd: home };
    await writeFile(launchPath, JSON.stringify(original));
    await expect(prepareReflectionLaunch(run, { memoryHome: home, extensionPath: "owned-extension.ts" })).rejects.toThrow("does not match");
    expect(JSON.parse(await readFile(launchPath, "utf8"))).toEqual(original);
    await expect(prepareReflectionLaunch(home, { memoryHome: home, extensionPath: "owned-extension.ts" })).rejects.toThrow("outside");
  } finally {
    const segment = relative(resolve(tmpdir()), resolve(home)).split(sep)[0];
    if (!segment?.startsWith("omo-mini-reflection-supervisor-")) throw Error("Refusing cleanup outside owned fixture");
    await rm(home, { recursive: true, force: true });
  }
});
