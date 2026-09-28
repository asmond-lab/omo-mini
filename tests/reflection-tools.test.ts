import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { commitReflectionFiles, readReflectionInput, ReflectionToolError, resolveReflectionPath } from "../src/reflection-tools.ts";

async function fixture(): Promise<{ root: string; repo: string; cleanup: () => Promise<void> }> {
  const identity = { GIT_AUTHOR_NAME: "ReflectionFixture", GIT_AUTHOR_EMAIL: "reflection@example.invalid", GIT_COMMITTER_NAME: "ReflectionFixture", GIT_COMMITTER_EMAIL: "reflection@example.invalid" } as const;
  const priorIdentity: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(identity)) { priorIdentity[key] = process.env[key]; process.env[key] = value; }
  const root = await mkdtemp(join(tmpdir(), "omo-mini-reflection-tools-"));
  const repo = join(root, "memory");
  await mkdir(join(repo, "system"), { recursive: true });
  execFileSync("git", ["init", "-q", repo], { windowsHide: true });
  await writeFile(join(repo, "system", "self-aware.md"), "old\n");
  execFileSync("git", ["-C", repo, "add", "--", "system/self-aware.md"], { windowsHide: true });
  execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"], { windowsHide: true });
  return { root, repo, cleanup: async () => {
    const owned = resolve(tmpdir());
    if (isAbsolute(root) && relative(owned, resolve(root)).split(sep)[0]?.startsWith("omo-mini-reflection-tools-")) await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(identity)) {
      const value = priorIdentity[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  } };
}

test("readReflectionInput pages every non-reasoning entry with bounded fields", async () => {
  const f = await fixture();
  try {
    // Given: tool data larger than the field cap, plus reasoning between two messages.
    const path = join(f.root, "payload.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, runId: "r1", request: { snapshots: [{ conversationId: "session-1", snapshot: { entries: [
      { kind: "user", text: "begin", source_line_id: "line-1", source_message_id: "msg-1" },
      { kind: "reasoning", text: "private", source_line_id: "line-2", source_message_id: "msg-2" },
      { kind: "tool_call", name: "bash", argsText: "x".repeat(4000), resultText: "y".repeat(4000), resultOk: false, source_line_id: "line-3", source_message_id: "msg-3" },
    ] } }] } }));
    // When: the consumer follows the cursor.
    const first = await readReflectionInput(path, { limit: 1 });
    const second = await readReflectionInput(path, { offset: first.nextOffset ?? 0, limit: 1 });
    // Then: only source entries are returned, with loss signaled.
    expect([first.total, first.nextOffset, first.entries[0]?.sourceMessageId]).toEqual([2, 1, "msg-1"]);
    expect([second.nextOffset, second.entries[0]?.kind, second.entries[0]?.sessionId]).toEqual([null, "tool_call", "session-1"]);
    const call = second.entries[0];
    expect(call?.kind === "tool_call" && call.argsText.length <= 2000 && call.resultText.length <= 2000 && call.truncatedFields.includes("argsText") && call.truncatedFields.includes("resultText")).toBe(true);
    expect(JSON.stringify(second).length).toBeLessThan(12000);
    expect((await readFile(path, "utf8")).includes("private")).toBe(true);
  } finally { await f.cleanup(); }
});

test("commitReflectionFiles commits only selected markdown changes", async () => {
  const f = await fixture();
  try {
    // Given: a changed memory file and an isolated repo identity.
    await writeFile(join(f.repo, "system", "self-aware.md"), "new\n");
    // When: the helper commits that exact path.
    const result = await commitReflectionFiles(f.repo, { paths: ["system/self-aware.md"], message: "reflection memory" });
    // Then: commit contains the intended file and leaves a clean tree.
    expect(result.kind).toBe("committed");
    expect(execFileSync("git", ["-C", f.repo, "show", "--format=", "--name-only", "HEAD"], { encoding: "utf8" }).trim()).toBe("system/self-aware.md");
    expect(execFileSync("git", ["-C", f.repo, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  } finally { await f.cleanup(); }
});

test("commitReflectionFiles refuses unrelated dirt without changing it", async () => {
  const f = await fixture();
  try {
    // Given: a selected memory edit and an unselected scratch file.
    await writeFile(join(f.repo, "system", "self-aware.md"), "new\n");
    await writeFile(join(f.repo, "scratch.md"), "keep\n");
    // When: committing only the selected file.
    const action = commitReflectionFiles(f.repo, { paths: ["system/self-aware.md"], message: "reflection memory" });
    // Then: the actionable refusal preserves both changes.
    await expect(action).rejects.toMatchObject({ code: "unrelated_changes" });
    expect(await readFile(join(f.repo, "scratch.md"), "utf8")).toBe("keep\n");
  } finally { await f.cleanup(); }
});

test("commitReflectionFiles rejects symlink and boundary paths", async () => {
  const f = await fixture();
  try {
    // Given: a symlink into the owned temp root and a protected memory path.
    await writeFile(join(f.root, "outside.md"), "outside\n");
    let linkCreated = false;
    try {
      await symlink(f.root, join(f.repo, "system", "link"), "junction");
      linkCreated = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) throw error;
    }
    // When: either path is submitted.
    const linked = linkCreated ? commitReflectionFiles(f.repo, { paths: ["system/link/outside.md"], message: "reflection memory" }) : undefined;
    // Then: neither can be staged.
    if (linked) await expect(linked).rejects.toBeInstanceOf(ReflectionToolError);
    await expect(commitReflectionFiles(f.repo, { paths: ["system/boundaries.md"], message: "reflection memory" })).rejects.toMatchObject({ code: "invalid_path" });
  } finally { await f.cleanup(); }
});

test("commitReflectionFiles refuses a pre-staged scratch file", async () => {
  const f = await fixture();
  try {
    // Given: a staged scratch file next to a selected memory edit.
    await writeFile(join(f.repo, "scratch.md"), "staged\n");
    execFileSync("git", ["-C", f.repo, "add", "--", "scratch.md"], { windowsHide: true });
    await writeFile(join(f.repo, "system", "self-aware.md"), "new\n");
    // When: the selected memory edit is offered to the helper.
    const action = commitReflectionFiles(f.repo, { paths: ["system/self-aware.md"], message: "reflection memory" });
    // Then: the index is preserved and no commit occurs.
    await expect(action).rejects.toMatchObject({ code: "staged_changes" });
    expect(execFileSync("git", ["-C", f.repo, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim()).toBe("scratch.md");
  } finally { await f.cleanup(); }
});

test("commitReflectionFiles reports no changes in a clean repository", async () => {
  const f = await fixture();
  try {
    // Given: an unchanged tracked memory file.
    // When: that path is offered to the helper.
    const result = await commitReflectionFiles(f.repo, { paths: ["system/self-aware.md"], message: "reflection memory" });
    // Then: no commit is created.
    expect(result.kind).toBe("no_changes");
    expect(execFileSync("git", ["-C", f.repo, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim()).toBe("1");
  } finally { await f.cleanup(); }
});

test("readReflectionInput packs short entries and respects the page budget", async () => {
  const f = await fixture();
  try {
    // Given: many short messages across several pages.
    const path = join(f.root, "many.json");
    const entries = Array.from({ length: 60 }, (_, index) => ({ kind: "user", text: `message-${index}`, source_line_id: `line-${index}`, source_message_id: `message-${index}` }));
    await writeFile(path, JSON.stringify({ schemaVersion: 1, runId: "many", request: { snapshots: [{ conversationId: "session", snapshot: { entries } }] } }));
    // When: the default page is read and its cursor is followed.
    const first = await readReflectionInput(path);
    const second = await readReflectionInput(path, { offset: first.nextOffset ?? 0 });
    // Then: pages pack 20 short entries without gaps or overrunning the budget.
    expect([first.entries.length, first.nextOffset, second.entries[0]?.sourceMessageId]).toEqual([20, 20, "message-20"]);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(12000);
    expect(JSON.stringify(second).length).toBeLessThanOrEqual(12000);
  } finally { await f.cleanup(); }
});

test("resolveReflectionPath rejects protected aliases and uncommittable writes", async () => {
  const f = await fixture();
  try {
    // Given: a memory worktree and a sibling file outside it.
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "outside\n");
    // When: paths are resolved for reading or writing.
    const readable = await resolveReflectionPath(f.repo, ".");
    const writable = await resolveReflectionPath(f.repo, "notes/new.md", true);
    // Then: ordinary paths resolve, while protected and out-of-scope paths fail.
    expect(readable).toBe(resolve(f.repo));
    expect(writable).toBe(resolve(f.repo, "notes/new.md"));
    for (const path of [outside, ".git/config", ".tmp/scratch.md", "system/boundaries.md", "root.md", "system/NUL.md", "system/trailing. /note.md"]) {
      await expect(resolveReflectionPath(f.repo, path, true)).rejects.toMatchObject({ code: "invalid_path" });
    }
  } finally { await f.cleanup(); }
});


test("readReflectionInput advances through JSON-escaped tool output within its page budget", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "escaped-payload.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, runId: "escaped", request: { snapshots: [{ conversationId: "session", snapshot: { entries: [
      { kind: "tool_call", name: "x".repeat(4000), argsText: "\u0001".repeat(4000), resultText: "\u0002".repeat(4000), resultOk: false, source_line_id: "line", source_message_id: "message" },
    ] } }] } }));
    const page = await readReflectionInput(path);
    expect(page.entries).toHaveLength(1);
    expect(page.nextOffset).toBeNull();
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(12000);
    expect(page.entries[0]?.truncatedFields).toContain("resultText");
  } finally { await f.cleanup(); }
});

test("Native home expansion is rejected before reflection file access", async () => {
  const f = await fixture();
  try {
    const { resolveNativeToolPath } = await import("../src/tool-progress.ts");
    const { resolveReflectionPath } = await import("../src/reflection-tools.ts");
    const path = await resolveNativeToolPath("write", "~/system/outside.md", f.repo);
    await expect(resolveReflectionPath(f.repo, path, true)).rejects.toMatchObject({ code: "invalid_path" });
  } finally { await f.cleanup(); }
});
