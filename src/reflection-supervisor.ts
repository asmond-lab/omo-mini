import { createRequire } from "node:module";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { MiniError } from "./local.ts";

const launchSchema = z.object({
  version: z.literal(1), kind: z.string(), runId: z.string(),
  args: z.array(z.string()), cwd: z.string(), env: z.record(z.string(), z.string()),
}).passthrough();

export async function prepareReflectionLaunch(runDirectory: string, options: { readonly memoryHome: string; readonly extensionPath: string }): Promise<void> {
  const run = await realpath(runDirectory);
  const home = await realpath(options.memoryHome);
  const parts = relative(home, run).split(sep);
  if (parts.length !== 6 || parts[0] !== "agents" || parts[2] !== "runtime" || parts[3] !== "reflection" || parts[4] !== "runs")
    throw new MiniError("reflection_launch", "Reflection run is outside the isolated mini memory runtime");
  const path = join(run, "launch.json");
  const launch = launchSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (launch.kind !== "reflection") return;
  const worktree = await realpath(launch.cwd);
  const worktreeParts = relative(home, worktree).split(sep);
  if (parts[5] !== launch.runId || worktreeParts.length !== 5 || worktreeParts[0] !== "agents" ||
      worktreeParts[1] !== parts[1] || worktreeParts[2] !== "runtime" || worktreeParts[3] !== "worktrees" ||
      !launch.env["MEMORY_DIR"] || await realpath(launch.env["MEMORY_DIR"]) !== worktree ||
      launch.env["OMO_MINI_LOCAL_PROFILE"] !== "1" || launch.env["SENPI_MEMORY_REFLECTION"] !== "1")
    throw new MiniError("reflection_launch", "Reflection launch identity or worktree does not match mini memory");
  const toolsAt = launch.args.indexOf("--tools");
  if (toolsAt < 0 || launch.args[toolsAt + 1] !== "bash,edit")
    throw new MiniError("reflection_launch", "Unexpected Native reflection tool contract");
  const args = [...launch.args];
  args[toolsAt + 1] = "read,grep,find,ls,edit,write,reflection_input,reflection_commit";
  args.splice(args.length - 1, 0, "--extension", options.extensionPath, "--permission", "reflection_input=allow,reflection_commit=allow");
  const temporary = join(run, `mini-launch-${process.pid}.json`);
  await writeFile(temporary, JSON.stringify({ ...launch, args }) + "\n", { flag: "wx" });
  await rename(temporary, path);
}

if (import.meta.main) {
  const run = process.argv[2];
  const memoryHome = process.env["OMO_MEMORY_HOME"];
  if (!run || !memoryHome || process.env["OMO_MINI_LOCAL_PROFILE"] !== "1")
    throw new MiniError("reflection_launch", "Missing isolated mini reflection environment");
  const extensionPath = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./reflection-extension.ts" : "./reflection-extension.js", import.meta.url));
  await prepareReflectionLaunch(run, { memoryHome, extensionPath });
  const require = createRequire(import.meta.url);
  const native = resolve(dirname(require.resolve("omo-ai/package.json")), "plugin/extensions/memory-run-supervisor.mjs");
  await import(pathToFileURL(native).href);
}
