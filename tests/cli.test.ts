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
  let discoveries = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/api/v0/models") { discoveries++; return Response.json({ data: [model] }); }
    inference++;
    return new Response("unexpected inference", { status: 500 });
  } });
  try {
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "run", "--root", root, "--task", "x".repeat(3000), "--base-url", `http://127.0.0.1:${server.port}/v1`, "--json"],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    // Windows CI cold startup can exceed Bun's default 5s test limit. Bound the
    // integration itself and report whether model discovery happened on deadline.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const [out, err, exit] = await Promise.race([
        Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error(`CLI admission exceeded 45s integration deadline (discoveries=${discoveries}, inference=${inference}, childExit=${proc.exitCode ?? "pending"})`)), 45000);
        }),
      ]);
      let result: { reason?: string; error?: { code?: string } };
      try { result = JSON.parse(out); }
      catch (error) { throw new Error(`Malformed CLI JSON (exit ${exit}, stdout ${JSON.stringify(out.slice(-1000))}, stderr ${JSON.stringify(err.slice(-1000))}): ${String(error)}`); }
      expect(exit).toBe(1);
      expect(result.reason).toBe("error");
      expect(result.error?.code).toBe("model_admission");
      expect(inference).toBe(0);
    } finally {
      if (deadline) clearTimeout(deadline);
      if (proc.exitCode === null) {
        if (process.platform === "win32") {
          // The CLI spawns Senpi; taskkill is scoped to this test-owned PID tree.
          const killer = Bun.spawn(["taskkill.exe", "/PID", String(proc.pid), "/T", "/F"], { stdout: "pipe", stderr: "pipe" });
          const [killExit, killOut, killErr] = await Promise.all([killer.exited, new Response(killer.stdout).text(), new Response(killer.stderr).text()]);
          if (killExit !== 0) throw new Error(`Owned CLI tree cleanup failed: ${killOut} ${killErr}`);
        } else proc.kill();
        await proc.exited;
      }
    }
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 60000);

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
