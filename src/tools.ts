import { realpath, readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { MiniError } from "./local.ts";

const MAX_FILE = 65536;
const MAX_RESULT = 12000;
const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".omo", ".senpi"]);

export async function workspace(root: string): Promise<string> {
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory()) throw new MiniError("root", "Root must be a directory");
  return canonical;
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function confined(root: string, name: string): Promise<string> {
  if (!name || name.includes("\0")) throw new MiniError("path", "Invalid path");
  const candidate = resolve(root, name);
  if (!contained(root, candidate)) throw new MiniError("path", "Path escapes workspace");
  let target: string;
  try { target = await realpath(candidate); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new MiniError("path", "Path not found in workspace");
    throw error;
  }
  if (!contained(root, target)) throw new MiniError("path", "Path escapes workspace");
  if (!(await stat(target)).isFile()) throw new MiniError("path", "Path is not a regular file");
  return target;
}

export async function readScoped(root: string, name: string): Promise<string> {
  const target = await confined(root, name);
  if ((await stat(target)).size > MAX_FILE) throw new MiniError("file_size", "File exceeds 64 KiB read limit");
  const lines = (await readFile(target, "utf8")).split("\n");
  const output = lines.slice(0, 200).map((line, index) => `${index + 1}: ${line}`).join("\n");
  return `${relative(root, target)}\n${output.slice(0, MAX_RESULT)}${output.length > MAX_RESULT || lines.length > 200 ? "\n[truncated]" : ""}`;
}

export async function searchScoped(root: string, pattern: string): Promise<string> {
  if (!pattern || pattern.length > 120) throw new MiniError("pattern", "Search text must be 1-120 characters");
  const queue = [root];
  const hits: string[] = [];
  let examined = 0;
  while (queue.length && examined < 300 && hits.length < 30) {
    const dir = queue.shift();
    if (!dir) break;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) { queue.push(path); continue; }
      if (!entry.isFile()) continue;
      examined++;
      const file = await confined(root, path);
      if ((await stat(file)).size > MAX_FILE) continue;
      const lines = (await readFile(file, "utf8")).split("\n");
      for (let i = 0; i < lines.length && hits.length < 30; i++) {
        const line = lines[i];
        if (line?.toLowerCase().includes(pattern.toLowerCase())) hits.push(`${relative(root, file)}:${i + 1}: ${line.slice(0, 180)}`);
      }
      if (examined >= 300 || hits.length >= 30) break;
    }
  }
  return hits.length ? hits.join("\n").slice(0, MAX_RESULT) : "No matches in scanned files";
}

export function scopedTools(root: string): AgentTool[] {
  return [
    { name: "read_file", label: "Read file", description: "Read numbered lines from a workspace file; path relative to root.",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
      execute: async (_id, args) => ({ content: [{ type: "text", text: await readScoped(root, z.object({ path: z.string() }).parse(args).path) }], details: null }) },
    { name: "search_files", label: "Search files", description: "Find literal case-insensitive text in workspace files; returns file:line snippets.",
      parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
      execute: async (_id, args) => ({ content: [{ type: "text", text: await searchScoped(root, z.object({ text: z.string() }).parse(args).text) }], details: null }) },
  ];
}
