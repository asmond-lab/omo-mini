import { expect, test } from "bun:test";
import { ToolProgressGuard, inspectionState } from "../src/tool-progress.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const file = { fileState: "fixture:v1", stableFile: true };
const input = { path: "fixture.txt", pattern: "PUBLIC", mode: "content" };
const text = (value: string) => [{ type: "text", text: value }];

function observed(guard: ToolProgressGuard, id: string, output = "PUBLIC-A", state = file): void {
  expect(guard.call(id, "grep", input, state)).toBeUndefined();
  guard.result(id, false, text(output));
}

test("same file inspections are blocked after two unchanged observations, ignoring grep timings", () => {
  const guard = new ToolProgressGuard();
  observed(guard, "first", "PUBLIC-A\n[grep: matches=1 files=1 searched=1 elapsedMs=4 engine=rg nextSkip=none]");
  observed(guard, "second", "PUBLIC-A\n[grep: matches=1 files=1 searched=1 elapsedMs=19 engine=rg nextSkip=none]");
  const block = guard.call("third", "grep", { mode: "content", pattern: "PUBLIC", path: "fixture.txt" }, file);
  expect(block?.block).toBe(true);
  expect(block?.terminate).toBe(false);
  expect(block?.reason).toContain("second");
  expect(block?.reason).toContain("PUBLIC-A");
});

test("changed file metadata permits verification after the same inspection was blocked", () => {
  const guard = new ToolProgressGuard();
  observed(guard, "first");
  observed(guard, "second");
  guard.call("third", "grep", input, file);
  expect(guard.call("changed", "grep", input, { fileState: "fixture:v2", stableFile: true })).toBeUndefined();
});

test("changed observations and distinct query pages are not counted as a success loop", () => {
  const guard = new ToolProgressGuard();
  observed(guard, "first", "PUBLIC-A");
  observed(guard, "second", "PUBLIC-B");
  expect(guard.call("third", "grep", input, file)).toBeUndefined();
  expect(guard.call("page", "grep", { ...input, offset: 100 }, file)).toBeUndefined();
});

test("shell and directory polling stays executable while repeated observations produce transient recovery", () => {
  const guard = new ToolProgressGuard();
  for (const id of ["shell1", "shell2"]) {
    expect(guard.call(id, "powershell", { command: "Get-Content status.txt", description: id })).toBeUndefined();
    guard.result(id, false, text("pending"));
  }
  const recovery = guard.consume([{ role: "assistant" }, { role: "toolResult", toolCallId: "shell2" }]);
  expect(recovery).toContain("<local_tool_recovery>");
  expect(recovery).toContain("pending");
  expect(guard.consume([{ role: "assistant" }, { role: "toolResult", toolCallId: "shell2" }])).toBeUndefined();
  expect(guard.call("shell3", "powershell", { command: "Get-Content status.txt" })).toBeUndefined();
  for (const id of ["dir1", "dir2", "dir3"]) {
    expect(guard.call(id, "grep", input, { fileState: "directory:v1", stableFile: false })).toBeUndefined();
    guard.result(id, false, text("PUBLIC-A"));
  }
});

test("latest user steering takes precedence over a pending repetition reminder", () => {
  const guard = new ToolProgressGuard();
  observed(guard, "first");
  observed(guard, "second");
  expect(guard.consume([{ role: "assistant" }, { role: "toolResult", toolCallId: "second" }, { role: "user" }])).toBeUndefined();
  expect(guard.consume([{ role: "assistant" }, { role: "toolResult", toolCallId: "second" }])).toBeUndefined();
});

test("failed and empty shell observations do not establish a successful loop", () => {
  const guard = new ToolProgressGuard();
  for (const id of ["first", "second"]) {
    guard.call(id, "bash", { command: "fixture" });
    guard.result(id, true, text("error"));
  }
  expect(guard.consume([{ role: "assistant" }, { role: "toolResult", toolCallId: "second" }])).toBeUndefined();
  for (const id of ["third", "fourth"]) {
    guard.call(id, "bash", { command: "fixture" });
    guard.result(id, false, text("(no output)"));
  }
  expect(guard.consume([{ role: "assistant" }, { role: "toolResult", toolCallId: "fourth" }])).toBeUndefined();
});

test("a persistent file loop terminates after three blocked attempts and resets for new input", () => {
  const guard = new ToolProgressGuard();
  observed(guard, "first");
  observed(guard, "second");
  expect(guard.call("third", "grep", input, file)?.terminate).toBe(false);
  expect(guard.call("fourth", "grep", input, file)?.terminate).toBe(false);
  expect(guard.call("fifth", "grep", input, file)?.terminate).toBe(true);
  expect(guard.stopped).toBe(true);
  guard.reset();
  expect(guard.call("new-user", "grep", input, file)).toBeUndefined();
  expect(guard.stopped).toBe(false);
});

test("real native target metadata changes after file creation and replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-file-state-"));
  try {
    const absent = await inspectionState("read", { path: "fixture.txt" }, root);
    await writeFile(join(root, "fixture.txt"), "PUBLIC-A");
    const created = await inspectionState("read", { path: "fixture.txt" }, root);
    await writeFile(join(root, "fixture.txt"), "PUBLIC-CHANGED-LONGER");
    const changed = await inspectionState("grep", { path: "fixture.txt" }, root);
    expect(created.stableFile).toBe(true);
    expect(created.fileState).not.toBe(absent.fileState);
    expect(changed.fileState).not.toBe(created.fileState);
    expect((await inspectionState("grep", { path: "." }, root)).stableFile).toBe(false);
    expect(await inspectionState("bash", { command: "fixture" }, root)).toEqual({});
  } finally {
    const inside = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(inside) || inside.startsWith(".." + sep) || !inside.startsWith("omo-mini-file-state-")) throw Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

test("file-state checks follow Native at-prefixed and Windows shell paths", async () => {
  const path = resolve(import.meta.dir, "tool-progress.test.ts");
  const canonical = await inspectionState("read", { path }, import.meta.dir);
  const prefixed = await inspectionState("read", { path: "@" + path }, import.meta.dir);
  expect(prefixed.fileState).toBe(canonical.fileState);
  if (process.platform === "win32") {
    const shellPath = "/" + path[0]?.toLowerCase() + path.slice(2).replaceAll("\\", "/");
    const shell = await inspectionState("read", { path: shellPath }, import.meta.dir);
    expect(shell.fileState).toBe(canonical.fileState);
  }
});

test("independent repeated-file actions do not accumulate one terminal loop count", () => {
  const guard = new ToolProgressGuard();
  for (const path of ["a.txt", "b.txt", "c.txt"]) {
    for (const id of ["first", "second"]) {
      guard.call(path + id, "read", { path }, file);
      guard.result(path + id, false, text("PUBLIC-A"));
    }
  }
  for (const path of ["a.txt", "b.txt", "c.txt"]) {
    expect(guard.call(path + "blocked", "read", { path }, file)?.terminate).toBe(false);
  }
  expect(guard.stopped).toBe(false);
});
