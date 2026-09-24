import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { MiniError } from "./local.ts";

const exec = promisify(execFile);
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_TEXT = 65536;
export type Attachment = { readonly image: ImageContent; readonly width: number; readonly height: number };
export type ClipboardValue = { readonly text: string; readonly attachment?: Attachment; readonly fileDrop?: readonly string[] };

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

/** Explorer's single copied image is an explicit attachment, not a workspace tool read. */
export async function fileDropAttachment(paths: readonly string[]): Promise<Attachment> {
  if (paths.length !== 1) throw new MiniError("clipboard_files", "Clipboard must contain exactly one image file");
  const path = paths[0]!;
  if (!/\.(png|jpe?g)$/i.test(path)) throw new MiniError("image_format", "Clipboard file must be PNG or JPEG");
  // FileInfo checks size before Image.FromFile opens it; the decoder validates actual pixels.
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; try { $f=New-Object System.IO.FileInfo($env:OMO_IMAGE_FILE); if(-not $f.Exists){throw 'missing'}; if($f.Length -gt 2097152){throw 'large'}; $i=[System.Drawing.Image]::FromFile($f.FullName); try { if($i.Width -lt 1 -or $i.Height -lt 1 -or ([long]$i.Width * $i.Height) -gt 16000000){throw 'dimensions'}; $m=New-Object System.IO.MemoryStream; try {$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png); if($m.Length -gt 2097152){throw 'large'}; @{image=[Convert]::ToBase64String($m.ToArray())}|ConvertTo-Json -Compress} finally {$m.Dispose()} } finally {$i.Dispose()} } catch { @{error= if($_.Exception.Message -in @('missing','large','dimensions')){$_.Exception.Message}else{'decode'}}|ConvertTo-Json -Compress }`;
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, OMO_IMAGE_FILE: path } });
  const value = JSON.parse(stdout) as { image?: string; error?: string };
  if (value.error) throw new MiniError(value.error === "large" || value.error === "dimensions" ? "image_size" : "image_format", `Clipboard image ${value.error}`);
  if (!value.image) throw new MiniError("image_format", "Clipboard image decode failed");
  return pngAttachment(Buffer.from(value.image, "base64"));
}

/** Read-only Windows clipboard snapshot: image takes priority, text included once if also present. */
export async function systemClipboard(): Promise<ClipboardValue> {
  if (process.platform !== "win32") throw new MiniError("clipboard", "System clipboard is supported only on Windows");
  const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $t=[System.Windows.Forms.Clipboard]::GetText(); $i=[System.Windows.Forms.Clipboard]::GetImage(); $v=@{text=$t;image=$null;fileDrop=$null;error=$null}; if($i -ne $null){try{if($i.Width -lt 1 -or $i.Height -lt 1 -or ([long]$i.Width * $i.Height) -gt 16000000){$v.error='dimensions'}else{$m=New-Object System.IO.MemoryStream; try{$i.Save($m,[System.Drawing.Imaging.ImageFormat]::Png);if($m.Length -gt 2097152){$v.error='large'}else{$v.image=[Convert]::ToBase64String($m.ToArray())}}finally{$m.Dispose()}}}finally{$i.Dispose()}}elseif([System.Windows.Forms.Clipboard]::ContainsFileDropList()){$v.fileDrop=@([System.Windows.Forms.Clipboard]::GetFileDropList())}; $v|ConvertTo-Json -Compress`;
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", script], { timeout: 7000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const value = parseClipboard(JSON.parse(stdout));
  return value.fileDrop ? { text: value.text, attachment: await fileDropAttachment(value.fileDrop) } : value;
}

export function parseClipboard(value: unknown): ClipboardValue {
  if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string" || !("image" in value) || (value.image !== null && typeof value.image !== "string")) {
    throw new MiniError("clipboard", "Malformed clipboard response");
  }
  if (Buffer.byteLength(value.text, "utf8") > MAX_TEXT) throw new MiniError("clipboard_size", "Clipboard text exceeds 64 KiB limit");
  const raw = value as { text: string; image: string | null; fileDrop?: unknown; error?: string | null };
  if (raw.error) throw new MiniError("image_size", `Clipboard image ${raw.error}`);
  const fileDrop = raw.fileDrop == null ? undefined : raw.fileDrop;
  if (fileDrop !== undefined && (!Array.isArray(fileDrop) || !fileDrop.every(p => typeof p === "string"))) throw new MiniError("clipboard", "Malformed clipboard file list");
  const attachment = raw.image ? pngAttachment(Buffer.from(raw.image, "base64")) : undefined;
  if (!raw.text && !attachment && !fileDrop) throw new MiniError("clipboard_empty", "Clipboard contains no text or image");
  return { text: raw.text, ...(attachment ? { attachment } : {}), ...(fileDrop ? { fileDrop: fileDrop as string[] } : {}) };
}
