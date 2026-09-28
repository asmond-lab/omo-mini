import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { document } from "./path";
test("document restricts traversal but allows nested documents", async () => {
  const parent = await mkdtemp(join(tmpdir(), "security-path-"));
  const root = join(parent, "docs");
  try {
    await mkdir(join(root, "inner"), { recursive: true });
    await writeFile(join(parent, "outside.txt"), "private");
    await writeFile(join(root, "inner", "ok.txt"), "allowed");
    expect(await document(root, "inner/ok.txt")).toBe("allowed");
    await expect(document(root, "../outside.txt")).rejects.toThrow();
    await expect(document(root, "inner/../../outside.txt")).rejects.toThrow();
    await (await import("node:fs/promises")).symlink(join(parent, "outside.txt"), join(root, "inner", "link.txt"));
    await expect(document(root, "inner/link.txt")).rejects.toThrow();
    expect(await readFile(join(parent, "outside.txt"), "utf8")).toBe("private");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
