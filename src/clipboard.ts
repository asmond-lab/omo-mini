import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { MiniError } from "./local.ts";

const exec = promisify(execFile);
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_TEXT = 65536;
export type Attachment = { readonly image: ImageContent; readonly width: number; readonly height: number };
export type ClipboardValue = { readonly text: string; readonly attachment?: Attachment };

export function pngAttachment(bytes: Buffer): Attachment {
  if (bytes.length > MAX_IMAGE) throw new MiniError("image_size", "Image exceeds 2 MiB limit");
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new MiniError("image_format", "Expected PNG image bytes");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > 16_000_000) throw new MiniError("image_size", "Image dimensions exceed limit");
  return { image: { type: "image", mimeType: "image/png", data: bytes.toString("base64") }, width, height };
}

export async function fileAttachment(path: string): Promise<Attachment> {
  return pngAttachment(await readFile(path));
}

/** Read-only Windows clipboard snapshot: image takes priority, text included once if also present. */
export async function systemClipboard(): Promise<ClipboardValue> {
  if (process.platform !== "win32") throw new MiniError("clipboard", "System clipboard is supported only on Windows");
  const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $t=[System.Windows.Forms.Clipboard]::GetText(); $i=[System.Windows.Forms.Clipboard]::GetImage(); $v=@{text=$t;image=$null}; if($i -ne $null){$m=New-Object System.IO.MemoryStream; try{$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png);$v.image=[Convert]::ToBase64String($m.ToArray())}finally{$m.Dispose();$i.Dispose()}}; $v|ConvertTo-Json -Compress`;
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", script], { timeout: 7000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return parseClipboard(JSON.parse(stdout));
}

export function parseClipboard(value: unknown): ClipboardValue {
  if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string" || !("image" in value) || (value.image !== null && typeof value.image !== "string")) {
    throw new MiniError("clipboard", "Malformed clipboard response");
  }
  if (Buffer.byteLength(value.text, "utf8") > MAX_TEXT) throw new MiniError("clipboard_size", "Clipboard text exceeds 64 KiB limit");
  const attachment = value.image ? pngAttachment(Buffer.from(value.image, "base64")) : undefined;
  if (!value.text && !attachment) throw new MiniError("clipboard_empty", "Clipboard contains no text or image");
  return { text: value.text, ...(attachment ? { attachment } : {}) };
}
