import { test, expect } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileDropImage } from "../node_modules/@code-yeongyu/senpi/dist/utils/clipboard-image.js";

test("native Alt+V FileDrop decodes public PNG without touching the clipboard", async () => {
  if (process.platform !== "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "omo-native-drop-"));
  try {
    const image = join(dir, "image.png");
    await copyFile(join(import.meta.dir, "../fixtures/tiny/image.png"), image);
    const result = await readFileDropImage([image]);
    expect(result.mimeType).toBe("image/png");
    expect(Buffer.from(result.bytes).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(() => readFileDropImage([])).toThrow("exactly one");
    expect(() => readFileDropImage([image, image])).toThrow("exactly one");
    const invalid = join(dir, "invalid.png");
    await writeFile(invalid, "not a PNG");
    await expect(readFileDropImage([invalid])).rejects.toThrow();
    const oversized = join(dir, "oversized.png");
    await writeFile(oversized, Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(readFileDropImage([oversized])).rejects.toThrow("oversized");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
