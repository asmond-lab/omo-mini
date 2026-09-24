#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stdout, stderr } from "node:process";
import { text } from "node:stream/consumers";
import { discover, MiniError } from "./local.ts";
import { parseArgs, prepareProfile, upstreamEntry } from "./profile.ts";

const HELP = `omo-mini 0.2.2 - independent local profile of OmO Native
Usage: omo-mini [--root PATH] [--state-dir PATH] [--model ID] [--base-url URL] [--permission workspace|ask|read-only]
       omo-mini run --root PATH --task TEXT [--image PATH] [--session NAME] [--json] [profile options]
       omo-mini doctor [--json] [profile options]
       omo-mini rpc [profile options] (native OmO JSONL protocol over stdin/stdout)
OmO's native TUI supplies /new, /resume, Alt+V image/text paste on Windows and project instructions.
Local-only; no inherited cloud auth, remote MCPs, or OmO global state. Profile defaults to ~/.omo-mini.
`;

async function imageArgument(root: string, image: string): Promise<string> {
  const file = await realpath(resolve(root, image));
  const rel = relative(root, file);
  if (rel === ".." || rel.startsWith(`..${sep}`))
    throw new MiniError("path", "Image must be inside the workspace");
  return `@${file}`;
}

export async function main(argv: readonly string[]): Promise<void> {
  const json = argv.includes("--json");
  try {
    const options = parseArgs(argv);
    if (options.command === "help") { stdout.write(HELP); return; }
    const root = await realpath(options.root);
    if (options.command === "doctor") {
      const selected = await discover(options.baseUrl, options.model);
      stdout.write(`${JSON.stringify({ reachable: true, provider: "omo-mini-local", model: selected.id, loadedContext: selected.loaded_context_length, workspace: root, stateDir: options.stateDir ?? "~/.omo-mini" })}\n`);
      return;
    }
    const profile = await prepareProfile({ ...options, root });
    const extension = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./extension.ts" : "./extension.js", import.meta.url));
    const args = [upstreamEntry(), "--offline", "--no-approve", "--no-model-fallback", "--no-recommended-models",
      "--no-extensions", "--no-prompt-templates", "--no-skills", "--omo-senpi-builtin-mcps-disabled",
      "--tools", "read,grep,find,ls,bash,powershell,edit,write,memory,create_goal,update_goal,get_goal,todo",
      "--omo-senpi-task-disabled", "--omo-senpi-thread-disabled", "--omo-senpi-onboarding-disabled",
      "--omo-senpi-lsp-disabled", "--omo-senpi-telemetry-disabled",
      "--extension", extension, "--session-dir", profile.paths.sessions,
      "--provider", "omo-mini-local", "--model", profile.model.id, "--models", `omo-mini-local/${profile.model.id}`,
      "--permission-preset", options.permission,
      "--permission", `${options.permission === "workspace" ? "memory=allow," : ""}create_goal=allow,update_goal=allow,get_goal=allow,todo=allow,bash:rm *=deny`];
    if (options.command === "rpc") args.push("--mode", "rpc");
    if (options.command === "run") {
      if (options.session) args.push("--session", resolve(profile.paths.sessions, `${options.session}.jsonl`));
      if (options.json) args.push("--mode", "json");
      args.push("--print");
      if (options.image) args.push(await imageArgument(root, options.image));
      args.push("--", options.task ?? "");
    }
    if (options.json) {
      const child = spawn(process.execPath, args, { cwd: root, env: profile.env, stdio: ["inherit", "pipe", "pipe"], windowsHide: true });
      const [code, output, errors] = await Promise.all([
        new Promise<number>((done, reject) => { child.once("error", reject); child.once("exit", (exit, signal) => done(signal ? 1 : exit ?? 1)); }),
        text(child.stdout), text(child.stderr),
      ]);
      if (errors) stderr.write(errors);
      if (output) stdout.write(output);
      const events: unknown[] = output.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
      });
      const terminal = events.filter((event): event is { type: "agent_end"; aborted?: boolean; messages: { role: string; stopReason?: string; errorMessage?: string; content?: { type: string; text?: string }[] }[] } =>
        typeof event === "object" && event !== null && "type" in event && event.type === "agent_end" && "messages" in event && Array.isArray(event.messages)).at(-1);
      const last = terminal?.messages.filter(message => message.role === "assistant").at(-1);
      const empty = last && !last.content?.some(part => part.type === "text" && part.text?.trim());
      const failed = code !== 0 || !terminal || terminal.aborted || last?.stopReason === "error" || last?.stopReason === "length" || empty;
      if (failed) {
        const admission = /ModelUsabilityBudgetError:([^\r\n]*)/.exec(errors);
        stdout.write(`${JSON.stringify({ type: "omo_mini_status", reason: "error", error: {
          code: admission ? "model_admission" : terminal?.aborted ? "cancelled" : last?.stopReason === "length" ? "output_length" : last?.stopReason === "error" || last?.errorMessage ? "provider" : empty ? "empty_answer" : "provider",
          message: admission?.[1]?.trim() ?? last?.errorMessage ?? (empty ? "Model returned an empty answer" : `OmO exited ${code} without a complete answer`),
        } })}\n`);
        process.exitCode = 1;
      }
    } else {
      const exit = await new Promise<number>((done, reject) => {
        const child = spawn(process.execPath, args, { cwd: root, env: profile.env, stdio: "inherit", windowsHide: false });
        child.once("error", reject);
        child.once("exit", (code, signal) => done(signal ? 1 : code ?? 1));
      });
      if (exit !== 0) process.exitCode = exit;
    }
  } catch (error) {
    const code = error instanceof MiniError ? error.code : "runtime";
    const message = error instanceof Error ? error.message : String(error);
    if (json) stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
    else stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
if (import.meta.main) await main(process.argv.slice(2));
