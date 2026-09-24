import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runTask } from "../src/run.ts";

const model = { id: "test", state: "loaded", type: "llm", loaded_context_length: 4096, capabilities: ["tool_use"] };
const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", created: 1,
  model: "test", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

test("real CLI JSON over-context fails before inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-cli-budget-"));
  let inference = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/v0/models") return Response.json({ data: [model] });
    inference++;
    return new Response("unexpected inference", { status: 500 });
  } });
  try {
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "run", "--root", root, "--task", "x".repeat(3000), "--base-url", `http://127.0.0.1:${server.port}/v1`, "--json"],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const result = JSON.parse(out);
    expect(exit).toBe(1);
    expect(result.reason).toBe("error");
    expect(result.error.code).toBe("model_admission");
    expect(inference).toBe(0);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("repeated invalid tool calls stop after three errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-cli-tool-errors-"));
  let inference = 0;
  const server = Bun.serve({ port: 0, fetch() {
    inference++;
    return new Response(`${chunk({ tool_calls: [{ index: 0, id: `bad${inference}`, type: "function", function: { name: "read_file", arguments: '{"path":"../outside"}' } }] })}${chunk({}, "tool_calls")}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const result = await runTask({ root, task: "read outside", selected: { ...model, loaded_context_length: 12000 }, baseUrl: `http://127.0.0.1:${server.port}/v1` });
    expect(result.reason).toBe("error");
    expect(result.error).toContain("Maximum of 3 tool errors");
    expect(result.tools.filter(tool => tool.isError)).toHaveLength(3);
    expect(inference).toBe(3);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
