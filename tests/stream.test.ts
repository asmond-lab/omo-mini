import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTask } from "../src/run.ts";
import { pngAttachment } from "../src/clipboard.ts";

const selected = { id: "fixture-vlm", state: "loaded", type: "vlm", loaded_context_length: 12000, capabilities: ["tool_use"] };
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta: object, finish: string | null = null) => event({ id: "test", object: "chat.completion.chunk", created: 1,
  model: "fixture-vlm", choices: [{ index: 0, delta, finish_reason: finish }] });

test("real SDK assembles streamed tool arguments, executes read, and returns grounded result", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-stream-"));
  await writeFile(join(root, "note.txt"), "invoice = base + handling\n");
  let calls = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return new Response("invalid", { status: 400 });
    calls++;
    const content = calls === 1 ? [
      chunk({ tool_calls: [{ index: 0, id: "call1", type: "function", function: { name: "read_file", arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"note.txt"}' } }] }),
      chunk({}, "tool_calls"),
    ] : [chunk({ content: "note.txt:1 adds base and handling." }), chunk({}, "stop")];
    if (calls === 2 && !JSON.stringify(body.messages).includes("invoice = base + handling")) return new Response("tool result absent", { status: 400 });
    return new Response(`${content.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const result = await runTask({ root, task: "Read the note and answer", selected, baseUrl: `http://localhost:${server.port}/v1` });
    expect(result.reason).toBe("stop");
    expect(result.tools[0]?.result).toContain("1: invoice = base + handling");
    expect(result.answer).toContain("note.txt:1");
    expect(calls).toBe(2);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("actual SDK wire request contains PNG image content in one user message", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-image-"));
  const bytes = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  bytes.write("IHDR", 12); bytes.writeUInt32BE(2, 16); bytes.writeUInt32BE(3, 20);
  let observed = "";
  const server = Bun.serve({ port: 0, async fetch(request) {
    observed = JSON.stringify(await request.json());
    return new Response(`${chunk({ content: "image received" })}${chunk({}, "stop")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const result = await runTask({ root, task: "read picture", selected, baseUrl: `http://localhost:${server.port}/v1`, images: [pngAttachment(bytes).image] });
    expect(result.reason).toBe("stop");
    expect(observed).toContain(`data:image/png;base64,${bytes.toString("base64")}`);
    expect(observed).toContain("read picture");
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("malformed streaming response stops with error rather than a success answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-malformed-"));
  const server = Bun.serve({ port: 0, fetch() { return new Response("not SSE", { headers: { "content-type": "text/event-stream" } }); } });
  try {
    const result = await runTask({ root, task: "hello", selected, baseUrl: `http://localhost:${server.port}/v1` });
    expect(result.reason).not.toBe("stop");
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("cancellation after provider receives request ends without claiming success", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-cancel-"));
  const controller = new AbortController();
  const server = Bun.serve({ port: 0, fetch() {
    controller.abort();
    return new Response(`${chunk({ content: "partial" })}`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const result = await runTask({ root, task: "cancel me", selected, baseUrl: `http://localhost:${server.port}/v1`, signal: controller.signal });
    expect(result.reason).not.toBe("stop");
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("budget guard prevents provider request without orphaning a tool pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-mini-budget-"));
  let calls = 0;
  const server = Bun.serve({ port: 0, fetch() { calls++; return new Response("unexpected"); } });
  try {
    const result = await runTask({ root, task: "x".repeat(3000), selected: { ...selected, loaded_context_length: 4000 }, baseUrl: `http://localhost:${server.port}/v1` });
    expect(result.reason).toBe("error");
    expect(result.error).toContain("no request sent");
    expect(calls).toBe(0);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
