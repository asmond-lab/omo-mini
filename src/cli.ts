#!/usr/bin/env bun
import { stdin, stdout, stderr } from "node:process";
import { discover, endpoint, MiniError } from "./local.ts";
import { systemClipboard, fileAttachment } from "./clipboard.ts";
import { confined, workspace } from "./tools.ts";
import { runTask } from "./run.ts";
import { InputAssembler } from "./input.ts";
import type { ImageContent } from "@earendil-works/pi-ai";

const HELP = `omo-mini 0.1.0 (read-only local agent)
Usage: omo-mini doctor [--base-url URL] [--model ID] [--json]
       omo-mini run --root PATH --task TEXT [--clipboard] [--image PNG] [--base-url URL] [--model ID] [--strategy baseline|grounded] [--json]
       omo-mini [--root PATH] [--base-url URL] [--model ID]  (interactive; /paste, /quit)
No global OmO configuration is read. Only a loaded tool-capable local model is selected.
`;

type Flags = { readonly command: "doctor" | "run" | "interactive" | "help"; readonly baseUrl: string; readonly model?: string | undefined;
  readonly root: string; readonly strategy?: "baseline" | "grounded" | undefined; readonly task?: string | undefined; readonly image?: string | undefined; readonly clipboard: boolean; readonly json: boolean };
export function parseArgs(argv: readonly string[]): Flags {
  const first = argv[0];
  const command = first === "doctor" || first === "run" ? first : first === "--help" || first === "-h" || first === "help" ? "help" : "interactive";
  const items = command === "interactive" ? argv : argv.slice(1);
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const key = items[i];
    if (key === "--help" || key === "-h") return { command: "help", baseUrl: "http://localhost:1234/v1", root: process.cwd(), clipboard: false, json: false };
    if (!key || !["--base-url", "--model", "--root", "--task", "--image", "--strategy", "--clipboard", "--json"].includes(key)) throw new MiniError("arguments", `Unknown argument: ${key}`);
    if (key === "--json" || key === "--clipboard") { if (switches.has(key)) throw new MiniError("arguments", `Duplicate ${key}`); switches.add(key); continue; }
    if (values.has(key) || !items[i + 1] || items[i + 1]?.startsWith("--")) throw new MiniError("arguments", `Missing or duplicate value: ${key}`);
    values.set(key, items[++i] ?? "");
  }
  if (command === "run" && !values.has("--task") && !switches.has("--clipboard")) throw new MiniError("arguments", "run requires --task or --clipboard");
  if (command === "doctor" && (values.has("--task") || values.has("--root") || values.has("--image") || values.has("--strategy") || switches.has("--clipboard"))) throw new MiniError("arguments", "doctor accepts only endpoint/model/json options");
  if (command === "interactive" && (values.has("--task") || values.has("--image") || values.has("--strategy") || switches.size)) throw new MiniError("arguments", "interactive accepts only endpoint/model/root options");
  if (command === "run" && switches.has("--clipboard") && values.has("--image")) throw new MiniError("arguments", "Choose --clipboard or --image, not both");
  const strategyValue = values.get("--strategy");
  if (strategyValue && strategyValue !== "baseline" && strategyValue !== "grounded") throw new MiniError("arguments", "--strategy must be baseline or grounded");
  const strategy = strategyValue === "grounded" ? "grounded" : strategyValue === "baseline" ? "baseline" : undefined;
  const baseUrl = values.get("--base-url") ?? "http://localhost:1234/v1";
  endpoint(baseUrl);
  return { command, baseUrl, root: values.get("--root") ?? process.cwd(), ...(values.has("--model") ? { model: values.get("--model") } : {}),
    ...(values.has("--task") ? { task: values.get("--task") } : {}), ...(values.has("--image") ? { image: values.get("--image") } : {}),
    ...(strategy ? { strategy } : {}), clipboard: switches.has("--clipboard"), json: switches.has("--json") };
}

async function run(flags: Flags, taskInput?: string, paste = false, signal?: AbortSignal): Promise<unknown> {
  const selected = await discover(flags.baseUrl, flags.model);
  if (flags.command === "doctor") return { reachable: true, model: selected.id, loadedContext: selected.loaded_context_length, toolCapable: true };
  const root = await workspace(flags.root);
  const images: ImageContent[] = [];
  let task = taskInput ?? flags.task ?? "";
  if (flags.clipboard || paste) {
    const value = await systemClipboard();
    if (value.text) task = task ? `${task}\n${value.text}` : value.text;
    if (value.attachment) { images.push(value.attachment.image); stderr.write(`Clipboard image: ${value.attachment.width}x${value.attachment.height} PNG\n`); }
  }
  if (flags.image) {
    const attachment = await fileAttachment(await confined(root, flags.image));
    if (!images.some(image => image.data === attachment.image.data)) images.push(attachment.image);
    stderr.write(`Attached image: ${attachment.width}x${attachment.height} PNG\n`);
  }
  if (!task && images.length) task = "Describe the attached image.";
  if (!task.trim()) throw new MiniError("arguments", "Task text is empty");
  if (Buffer.byteLength(task, "utf8") > 65536) throw new MiniError("arguments", "Task exceeds 64 KiB");
  if (images.length && selected.type !== "vlm") throw new MiniError("model_capability", "Loaded model does not advertise vision support");
  const result = await runTask({ root, task, selected, baseUrl: flags.baseUrl, ...(flags.strategy ? { strategy: flags.strategy } : {}), ...(images.length ? { images } : {}), ...(signal ? { signal } : {}) });
  if (result.reason !== "stop" && flags.command === "run") process.exitCode = 1;
  return result;
}

async function interactive(flags: Flags): Promise<void> {
  if (!stdin.isTTY || !stdin.setRawMode) throw new MiniError("terminal", "Interactive mode requires a terminal; use run for scripts");
  stdout.write("omo-mini read-only local mode. /paste reads clipboard; /quit exits. Each task starts fresh.\nomo-mini> ");
  const input = new InputAssembler();
  const queue: string[] = [];
  let active: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let quitting = false;
  const drain = () => {
    if (active || quitting) return;
    const line = queue.shift();
    if (line === undefined) return;
    controller = new AbortController();
    const signal = controller.signal;
    active = (async () => {
      try {
        const result = await run(flags, line.trim() === "/paste" ? "" : line, line.trim() === "/paste", signal);
        if (typeof result === "object" && result && "answer" in result) stdout.write(`${result.answer}\n`);
      } catch (error) { stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); }
    })().finally(() => { active = undefined; controller = undefined; if (!quitting) { stdout.write("omo-mini> "); drain(); } });
  };
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdout.write("\x1b[?2004h");
  try {
    for await (const chunk of stdin) {
      const raw = String(chunk);
      if (controller && raw.includes("\x03")) {
        controller.abort();
        if (raw === "\x03") continue;
      }
      stdout.write(input.echo(raw));
      for (const line of input.feed(raw)) {
        if (line === "/quit") {
          if (controller) { controller.abort(); continue; }
          quitting = true; return;
        }
        if (line.trim()) queue.push(line);
      }
      drain();
    }
    if (active) await active;
  } finally { controller?.abort(); stdout.write("\x1b[?2004l\n"); stdin.setRawMode(false); }
}

export async function main(argv: readonly string[]): Promise<void> {
  let json = argv.includes("--json");
  try {
    const flags = parseArgs(argv);
    json = flags.json;
    if (flags.command === "help") { stdout.write(HELP); return; }
    if (flags.command === "interactive") { await interactive(flags); return; }
    const result = await run(flags);
    stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof MiniError ? error.code : "runtime";
    const message = error instanceof Error ? error.message : String(error);
    if (json) stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
    else stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  }
}
if (import.meta.main) await main(process.argv.slice(2));
