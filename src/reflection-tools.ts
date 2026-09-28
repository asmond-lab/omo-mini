import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const FIELD_LIMIT = 2000;
const PAGE_BUDGET = 12000;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 40;
const MEMORY_SECTIONS = new Set(["system", "skills", "reference", "notes"]);
const id = z.string().max(256);
const entrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reasoning") }),
  z.object({ kind: z.enum(["user", "assistant", "error"]), text: z.string(), source_line_id: id, source_message_id: id }),
  z.object({ kind: z.literal("tool_call"), name: z.string(), argsText: z.string(), resultText: z.string(), resultOk: z.boolean(), source_line_id: id, source_message_id: id }),
]);
const payloadSchema = z.object({ schemaVersion: z.number().int(), runId: id, request: z.object({ snapshots: z.array(z.object({ conversationId: id, snapshot: z.object({ entries: z.array(entrySchema) }) })) }) });
const pageOptionsSchema = z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE) });
const commitInputSchema = z.object({ paths: z.array(z.string()).min(1), message: z.string().trim().min(1).max(240) });

export class ReflectionToolError extends Error {
  readonly name = "ReflectionToolError";
  constructor(readonly code: "invalid_input" | "invalid_path" | "unrelated_changes" | "staged_changes" | "git_failed" | "not_repository", message: string, readonly details?: readonly string[]) {
    super(message);
  }
}

export type ReflectionEntry =
  | { readonly kind: "user" | "assistant" | "error"; readonly sessionId: string; readonly sourceLineId: string; readonly sourceMessageId: string; readonly text: string; readonly truncatedFields: readonly string[] }
  | { readonly kind: "tool_call"; readonly sessionId: string; readonly sourceLineId: string; readonly sourceMessageId: string; readonly name: string; readonly argsText: string; readonly resultText: string; readonly resultOk: boolean; readonly truncatedFields: readonly string[] };
export type ReflectionPage = { readonly schemaVersion: number; readonly runId: string; readonly offset: number; readonly nextOffset: number | null; readonly total: number; readonly entries: readonly ReflectionEntry[] };
export type ReflectionCommitResult = { readonly kind: "committed"; readonly sha: string; readonly paths: readonly string[] } | { readonly kind: "no_changes"; readonly paths: readonly string[] };

function clipped(value: string, field: string, truncatedFields: string[]): string {
  if (JSON.stringify(value).length <= FIELD_LIMIT) return value;
  truncatedFields.push(field);
  let lower = 0, upper = Math.min(value.length, FIELD_LIMIT);
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (JSON.stringify(value.slice(0, middle)).length <= FIELD_LIMIT) lower = middle;
    else upper = middle - 1;
  }
  return value.slice(0, lower);
}

export async function readReflectionInput(transcriptPath: string, options: { readonly offset?: number; readonly limit?: number } = {}): Promise<ReflectionPage> {
  const parsedOptions = pageOptionsSchema.safeParse(options);
  if (!parsedOptions.success) throw new ReflectionToolError("invalid_input", "Reflection page offset and limit must be positive integers");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(transcriptPath, "utf8")); }
  catch (error) {
    if (error instanceof Error) throw new ReflectionToolError("invalid_input", `Cannot read reflection payload: ${error.message.slice(0, 300)}`);
    throw error;
  }
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) throw new ReflectionToolError("invalid_input", "Reflection payload has an unexpected schema");
  const payload = parsed.data;
  const visible = payload.request.snapshots.flatMap(({ conversationId, snapshot }) => snapshot.entries.flatMap((entry) => entry.kind === "reasoning" ? [] : [{ sessionId: conversationId, entry }]));
  const offset = parsedOptions.data.offset;
  if (offset > visible.length) throw new ReflectionToolError("invalid_input", "Reflection page offset exceeds the entry count");
  const entries: ReflectionEntry[] = [];
  for (const { sessionId, entry } of visible.slice(offset, offset + parsedOptions.data.limit)) {
    const truncatedFields: string[] = [];
    let rendered: ReflectionEntry;
    switch (entry.kind) {
      case "user": case "assistant": case "error":
        rendered = { kind: entry.kind, sessionId, sourceLineId: entry.source_line_id, sourceMessageId: entry.source_message_id, text: clipped(entry.text, "text", truncatedFields), truncatedFields };
        break;
      case "tool_call":
        rendered = { kind: entry.kind, sessionId, sourceLineId: entry.source_line_id, sourceMessageId: entry.source_message_id, name: clipped(entry.name, "name", truncatedFields), argsText: clipped(entry.argsText, "argsText", truncatedFields), resultText: clipped(entry.resultText, "resultText", truncatedFields), resultOk: entry.resultOk, truncatedFields };
        break;
    }
    const candidate = { schemaVersion: payload.schemaVersion, runId: payload.runId, offset, nextOffset: offset + entries.length + 1, total: visible.length, entries: [...entries, rendered] };
    if (JSON.stringify(candidate).length > PAGE_BUDGET) {
      if (!entries.length) throw new ReflectionToolError("invalid_input", "Reflection entry metadata exceeds the page budget");
      break;
    }
    entries.push(rendered);
  }
  const next = offset + entries.length;
  return { schemaVersion: payload.schemaVersion, runId: payload.runId, offset, nextOffset: next < visible.length ? next : null, total: visible.length, entries };
}

function pathSegments(path: string): readonly string[] { return path.replaceAll("\\", "/").split("/").filter(Boolean); }
function forbidden(path: string): boolean { return pathSegments(path).some((part) => part.toLowerCase() === ".git" || part.toLowerCase() === ".tmp"); }

export async function resolveReflectionPath(worktree: string, path: string, writable = false): Promise<string> {
  if (!path || path.includes("\0")) throw new ReflectionToolError("invalid_path", "Path is empty or contains NUL");
  const root = await realpath(worktree);
  // Native resolves tool paths against a cwd that can name this worktree through an alias of its
  // real path (a Windows 8.3 short name or a junction). Rebase such a path onto the real root.
  const aliased = relative(resolve(worktree), resolve(root, path));
  const target = isAbsolute(path) && aliased !== ".." && !aliased.startsWith(`..${sep}`) && !isAbsolute(aliased)
    ? resolve(root, aliased) : resolve(root, path);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || forbidden(rel)) throw new ReflectionToolError("invalid_path", "Path escapes or enters protected reflection space");
  if (pathSegments(rel).some((part) => /[:\s.]$/.test(part) || part.includes(":") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new ReflectionToolError("invalid_path", "Path uses an unsafe Windows alias or device name");
  if (writable && (rel.toLowerCase() === join("system", "boundaries.md").toLowerCase() || !rel.toLowerCase().endsWith(".md") || !MEMORY_SECTIONS.has((pathSegments(rel)[0] ?? "").toLowerCase()))) throw new ReflectionToolError("invalid_path", "Reflection writes require an allowed memory Markdown path");
  let current = root;
  for (const part of pathSegments(rel)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new ReflectionToolError("invalid_path", "Reflection paths cannot traverse symlinks");
      const canonical = relative(root, await realpath(current));
      if (canonical === ".." || canonical.startsWith(`..${sep}`) || isAbsolute(canonical) || forbidden(canonical)) throw new ReflectionToolError("invalid_path", "Resolved path enters protected reflection space");
    } catch (error) {
      if (error instanceof ReflectionToolError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

async function git(worktree: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", worktree, ...args], { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (error instanceof Error) throw new ReflectionToolError("git_failed", `Git ${args[0] ?? "command"} failed: ${error.message.slice(0, 300)}`);
    throw error;
  }
}

export async function commitReflectionFiles(worktree: string, input: { readonly paths: readonly string[]; readonly message: string }): Promise<ReflectionCommitResult> {
  const parsed = commitInputSchema.safeParse(input);
  if (!parsed.success) throw new ReflectionToolError("invalid_input", "Commit requires explicit paths and a short message");
  const root = await realpath(worktree);
  const gitRoot = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  if (resolve(gitRoot).toLowerCase() !== root.toLowerCase()) throw new ReflectionToolError("not_repository", "Worktree must be the repository root");
  const paths = [...new Set(parsed.data.paths)];
  for (const path of paths) {
    if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") || /[?*\[\]:\n\r]/.test(path) || !path.toLowerCase().endsWith(".md") || !MEMORY_SECTIONS.has(path.split("/")[0] ?? "")) throw new ReflectionToolError("invalid_path", `Commit path is not an allowed relative memory Markdown path: ${path.slice(0, 100)}`);
    await resolveReflectionPath(root, path, true);
  }
  const staged = (await git(root, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
  if (staged.length) throw new ReflectionToolError("staged_changes", "Git index contains pre-staged changes", staged.slice(0, 20));
  const status = (await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])).split("\0").filter(Boolean);
  const dirty: string[] = [];
  for (let i = 0; i < status.length; i++) {
    const record = status[i];
    if (!record) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code.includes("R") || code.includes("C")) {
      dirty.push(path);
      i++;
    } else if (!paths.includes(path) || code.includes("D")) dirty.push(path);
  }
  if (dirty.length) throw new ReflectionToolError("unrelated_changes", "Unselected, renamed, or deleted changes remain in the worktree", dirty.slice(0, 20));
  if (!status.length) return { kind: "no_changes", paths };
  await git(root, ["add", "--", ...paths]);
  const stagedPaths = (await git(root, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
  if (!stagedPaths.length) {
    const remaining = (await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])).split("\0").filter(Boolean);
    if (remaining.length) throw new ReflectionToolError("unrelated_changes", "No staged changes, but the worktree is still dirty", remaining.slice(0, 20));
    return { kind: "no_changes", paths };
  }
  if (stagedPaths.some((path) => !paths.includes(path))) throw new ReflectionToolError("staged_changes", "Index contains an unexpected path after staging", stagedPaths.slice(0, 20));
  await git(root, ["commit", "-m", parsed.data.message]);
  const remaining = (await git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])).split("\0").filter(Boolean);
  if (remaining.length) throw new ReflectionToolError("unrelated_changes", "Commit succeeded but the worktree is still dirty", remaining.slice(0, 20));
  return { kind: "committed", sha: (await git(root, ["rev-parse", "HEAD"])).trim(), paths: stagedPaths };
}
