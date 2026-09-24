import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("OmO denies a destructive bash tool before executing it", async () => {
  let generations = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/v0/models") return Response.json({ data: [{ id: "fixture", state: "loaded", type: "llm", loaded_context_length: 200000, capabilities: ["tool_use"] }] });
    generations++;
    const delta = generations === 1 ? { tool_calls: [{ index: 0, id: "destructive", type: "function", function: { name: "bash", arguments: '{"command":"rm -rf marker.txt"}' } }] } : { content: "Denied command; no deletion performed." };
    const finish = generations === 1 ? "tool_calls" : "stop";
    return new Response(`data: ${JSON.stringify({ id: "one", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "one", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-permission-"));
  try {
    await writeFile(join(dir, "marker.txt"), "untouched");
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "run", "--root", dir, "--state-dir", join(dir, "profile"),
      "--base-url", `http://127.0.0.1:${server.port}/v1`, "--task", "Do not remove marker.txt", "--json"],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [exit, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    const events = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    expect(exit).toBe(0);
    expect(await readFile(join(dir, "marker.txt"), "utf8")).toBe("untouched");
    expect(events.filter(event => event.type === "tool_execution_end").some(event => event.isError || event.result?.isError)).toBe(true);
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 60000);
