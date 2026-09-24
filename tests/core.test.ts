import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseModel, checkBudget, MiniError } from "../src/local.ts";
import { confined, readScoped, searchScoped, workspace } from "../src/tools.ts";
import { pngAttachment, parseClipboard, fileDropAttachment } from "../src/clipboard.ts";
import { InputAssembler } from "../src/input.ts";
import { parseArgs } from "../src/cli.ts";

const model = { id: "local", state: "loaded", type: "vlm", loaded_context_length: 4096, capabilities: ["tool_use"] };

test("selects only loaded tool-capable model and rejects ambiguous overrides", () => {
  expect(chooseModel([model, { ...model, id: "embedding", capabilities: [] }]).id).toBe("local");
  expect(() => chooseModel([model, { ...model, id: "other" }])).toThrow("exactly one");
  expect(() => chooseModel([model], "other")).toThrow("not loaded");
  expect(() => chooseModel([])).toThrow(MiniError);
});

test("bounds complete request including tool schema before streaming", () => {
  expect(checkBudget([{ role: "system", toolsAdded: [{ description: "a" }] }], 6000)).toBeGreaterThan(0);
  expect(() => checkBudget([{ role: "system", toolsAdded: [{ description: "x".repeat(6000) }] }], 6000)).toThrow("no request sent");
});

test("realpath confines reads and search and rejects symlink escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-test-"));
  try {
    const root = join(dir, "root");
    await mkdir(root);
    await writeFile(join(root, "inside.txt"), "alpha\nbeta\n");
    await mkdir(join(dir, "outside"));
    await writeFile(join(dir, "outside", "outside.txt"), "SECRET\n");
    await symlink(join(dir, "outside"), join(root, "linked"), "junction");
    const canonical = await workspace(root);
    expect(await readScoped(canonical, "inside.txt")).toContain("2: beta");
    expect(await searchScoped(canonical, "beta")).toContain("inside.txt:2");
    expect(await searchScoped(canonical, "does-not-exist")).toContain("No matches");
    await expect(confined(canonical, "../outside/outside.txt")).rejects.toThrow("escapes workspace");
    await expect(confined(canonical, "missing.txt")).rejects.toThrow("Path not found in workspace");
    await expect(confined(canonical, "linked/outside.txt")).rejects.toThrow("escapes workspace");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("PNG bytes become image content; oversized and empty images fail", () => {
  const png = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(2, 16); png.writeUInt32BE(3, 20);
  const attachment = pngAttachment(png);
  expect(attachment.image).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
  expect([attachment.width, attachment.height]).toEqual([2, 3]);
  expect(() => pngAttachment(Buffer.alloc(0))).toThrow("Expected PNG");
  expect(() => pngAttachment(Buffer.alloc(2 * 1024 * 1024 + 1))).toThrow("2 MiB");
});

test("clipboard rejects empty and oversized input and retains text once with image", () => {
  expect(() => parseClipboard({ text: "", image: null })).toThrow("no text or image");
  expect(() => parseClipboard({ text: "x".repeat(65537), image: null })).toThrow("64 KiB");
  expect(() => parseClipboard({ text: "hello", image: "not-png" })).toThrow("Expected PNG");
  expect(parseClipboard({ text: "first\n猫", image: null }).text).toBe("first\n猫");
});

test("FileDrop decodes one real PNG, preserves Unicode text and rejects unsupported/invalid entries", async () => {
  if (process.platform !== "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-images-"));
  try {
    const path = join(dir, "picture.png");
    const original = await readFile(join(import.meta.dir, "../fixtures/tiny/image.png"));
    await copyFile(join(import.meta.dir, "../fixtures/tiny/image.png"), path);
    const value = parseClipboard({ text: "猫\n하늘", image: null, fileDrop: [path] });
    expect(value.text).toBe("猫\n하늘");
    const attachment = await fileDropAttachment(value.fileDrop!);
    expect([attachment.width, attachment.height]).toEqual([420, 120]);
    expect(Buffer.from(attachment.image.data, "base64").subarray(0, 8)).toEqual(original.subarray(0, 8));
    const jpeg = join(dir, "picture.jpg");
    const conversion = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile($env:OMO_SRC); try{$i.Save($env:OMO_DST,[System.Drawing.Imaging.ImageFormat]::Jpeg)}finally{$i.Dispose()}"], { env: { ...process.env, OMO_SRC: path, OMO_DST: jpeg } });
    expect(conversion.exitCode).toBe(0);
    expect((await fileDropAttachment([jpeg])).width).toBe(420);
    const huge = join(dir, "dimensions.png");
    const generated = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Drawing; $i=New-Object System.Drawing.Bitmap(4001,4000); try{$i.Save($env:OMO_DST,[System.Drawing.Imaging.ImageFormat]::Png)}finally{$i.Dispose()}"], { env: { ...process.env, OMO_DST: huge } });
    expect(generated.exitCode).toBe(0);
    await expect(fileDropAttachment([huge])).rejects.toThrow("dimensions");
    await expect(fileDropAttachment([])).rejects.toThrow("exactly one");
    await expect(fileDropAttachment([path, path])).rejects.toThrow("exactly one");
    await expect(fileDropAttachment([join(dir, "missing.png")])).rejects.toThrow("missing");
    await writeFile(join(dir, "notes.txt"), "private text");
    await expect(fileDropAttachment([join(dir, "notes.txt")])).rejects.toThrow("PNG or JPEG");
    await writeFile(join(dir, "fake.png"), original.subarray(0, 24));
    await expect(fileDropAttachment([join(dir, "fake.png")])).rejects.toThrow("decode");
    await writeFile(join(dir, "large.png"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(fileDropAttachment([join(dir, "large.png")])).rejects.toThrow("large");
    expect(() => parseClipboard({ text: "", image: null, fileDrop: [path, path] })).not.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test("multiline Unicode paste retains line breaks as one task", () => {
  const assembler = new InputAssembler();
  expect(assembler.feed("\x1b[200~first\n猫\nthird\x1b[201~")).toEqual([]);
  expect(assembler.feed("\r")).toEqual(["first\n猫\nthird"]);
  expect(new InputAssembler().feed("first\n猫\n")).toEqual(["first\n猫"]);
});

test("real CLI entry prints help and exits nonzero for invalid flags", () => {
  const help = Bun.spawnSync([process.execPath, "src/cli.ts", "--help"], { cwd: join(import.meta.dir, "..") });
  expect(help.exitCode).toBe(0);
  expect(new TextDecoder().decode(help.stdout)).toContain("omo-mini 0.1.0");
  const invalid = Bun.spawnSync([process.execPath, "src/cli.ts", "run", "--root", ".", "--json"], { cwd: join(import.meta.dir, "..") });
  expect(invalid.exitCode).toBe(1);
  expect(JSON.parse(new TextDecoder().decode(invalid.stdout)).error.code).toBe("arguments");
});

test("CLI rejects missing task, bad URL and unknown argument", () => {
  expect(() => parseArgs(["run", "--root", "."])).toThrow("requires --task");
  expect(() => parseArgs(["doctor", "--base-url", "https://user:secret@server/v1"])).toThrow("without credentials");
  expect(() => parseArgs(["run", "--wat"])).toThrow("Unknown argument");
});

test("paste markers split across chunks and embedded controls are assembled once", () => {
  const assembler = new InputAssembler();
  const esc = String.fromCharCode(27);
  expect(assembler.echo(esc + "[20")).toBe("");
  expect(assembler.echo("0~first" + String.fromCharCode(10) + "猫" + String.fromCharCode(10) + "third" + esc + "[20")).toBe("first" + String.fromCharCode(10) + "猫" + String.fromCharCode(10) + "third");
  expect(assembler.echo("1~" + String.fromCharCode(13))).toBe(String.fromCharCode(10));
  expect(assembler.feed("\x1b[20")).toEqual([]);
  expect(assembler.feed("0~first\n猫\nthird\x1b[20")).toEqual([]);
  expect(assembler.feed("1~")).toEqual([]);
  expect(assembler.feed("\r")).toEqual(["first\n猫\nthird"]);
  expect(new InputAssembler().feed("ab\x03")).toEqual(["/quit"]);
});

test("image budget counts vision tiles, not PNG base64 as text tokens", () => {
  const png = Buffer.alloc(1_500_000);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.write("IHDR", 12); png.writeUInt32BE(420, 16); png.writeUInt32BE(120, 20);
  const request = { system: "investigate", tools: [{ name: "read_file" }], messages: [{ content: [pngAttachment(png).image] }] };
  expect(checkBudget(request, 12000)).toBeLessThan(12000);
  png.writeUInt32BE(4000, 16); png.writeUInt32BE(4000, 20);
  expect(() => checkBudget({ messages: [pngAttachment(png).image] }, 12000)).toThrow("no request sent");
});

test("CLI strategy and command-specific arguments reject invalid configuration", () => {
  expect(parseArgs(["run", "--task", "hello", "--strategy", "grounded"]).strategy).toBe("grounded");
  expect(() => parseArgs(["run", "--task", "hello", "--strategy", "unknown"])).toThrow("--strategy");
  expect(() => parseArgs(["--json"])).toThrow("interactive accepts");
});
