import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native OmO JSONL reports length, empty and provider error without a silent success", async () => {
  let finish = "length";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/v0/models") return Response.json({ data: [{ id: "fixture", state: "loaded", type: "llm", loaded_context_length: 200000, capabilities: ["tool_use"] }] });
    if (finish === "error") return new Response("provider unavailable", { status: 503 });
    const content = finish === "length" ? "Partial text" : "";
    return new Response(`data: ${JSON.stringify({ id: "one", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "one", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  } });
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-status-"));
  async function run() {
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "run", "--root", "fixtures/tiny", "--state-dir", dir,
      "--base-url", `http://127.0.0.1:${server.port}/v1`, "--task", "Say OK", "--json"],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [code, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    const records = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    return { code, status: records.findLast(record => record.type === "omo_mini_status") };
  }
  try {
    const length = await run();
    expect(length.code).toBe(1);
    expect(length.status?.error.code).toBe("output_length");
    finish = "stop";
    const empty = await run();
    expect(empty.code).toBe(1);
    expect(empty.status?.error.code).toBe("empty_answer");
    finish = "error";
    const error = await run();
    expect(error.code).toBe(1);
    expect(error.status?.error.code).toBe("provider");
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 100000);
