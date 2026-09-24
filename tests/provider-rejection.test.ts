import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { profileEnvironment, profilePaths, upstreamEntry } from "../src/profile.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the real omo-ai -> Senpi -> pi-ai -> HTTP path, not a mocked extension runner.
test("local profile rejects bounded request before HTTP and permits a fitting request", async () => {
  let context = 34000;
  let generations = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v0/models") return Response.json({ data: [{ id: "test-local", state: "loaded", type: "vlm", capabilities: ["tool_use"], loaded_context_length: context }] });
    if (path === "/v1/chat/completions") {
      generations++;
      return new Response('data: {"id":"one","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"one","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("Not Found", { status: 404 });
  } });
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-reject-"));
  const run = async (task: string) => {
    const proc = Bun.spawn([process.execPath, "src/cli.ts", "run", "--root", "fixtures/tiny", "--state-dir", dir, "--base-url", `http://127.0.0.1:${server.port}/v1`, "--task", task, "--json"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const result = await Promise.race([proc.exited, new Promise<never>((_, reject) => { const timeout = setTimeout(() => { proc.kill(); reject(new Error("CLI did not exit within 45s")); }, 45000); void proc.exited.finally(() => clearTimeout(timeout)); })]);
    return { code: result, output: await new Response(proc.stdout).text(), errors: await new Response(proc.stderr).text() };
  };
  try {
    const rejected = await run("한".repeat(12000));
    expect(`${rejected.output}\n${rejected.errors} (exit ${rejected.code})`).toContain("no request sent");
    expect(generations).toBe(0);
    context = 200000;
    const allowed = await run("Say OK");
    expect(allowed.code).toBe(0);
    expect(allowed.output).toContain("OK");
    expect(generations).toBe(1);
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 110000);

test("native OmO rejects a selected nonlocal provider before any HTTP generation", async () => {
  let generations = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/v1/chat/completions") generations++;
    return Response.json({ data: [] });
  } });
  const dir = await mkdtemp(join(tmpdir(), "omo-mini-provider-"));
  const paths = profilePaths(dir);
  try {
    await Promise.all([mkdir(paths.agent, { recursive: true }), mkdir(paths.home, { recursive: true }), mkdir(paths.sessions, { recursive: true })]);
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    await writeFile(join(paths.agent, "models.json"), JSON.stringify({ providers: { "fake-cloud": {
      baseUrl, api: "openai-completions", apiKey: "local-fixture", models: [{ id: "wrong-model", contextWindow: 200000, maxTokens: 512 }],
    } } }));
    const selected = { id: "allowed-model", loaded_context_length: 200000, state: "loaded", type: "llm", capabilities: ["tool_use"] };
    const env = profileEnvironment(process.env, paths, selected, baseUrl, join(import.meta.dir, "..", "fixtures", "tiny"));
    const proc = Bun.spawn([process.execPath, upstreamEntry(), "--offline", "--no-approve", "--no-extensions", "--no-skills",
      "--extension", join(import.meta.dir, "..", "src", "extension.ts"), "--provider", "fake-cloud", "--model", "wrong-model",
      "--session-dir", paths.sessions, "--no-session", "--print", "Say OK"],
    { cwd: join(import.meta.dir, "..", "fixtures", "tiny"), env, stdout: "pipe", stderr: "pipe" });
    const [code, output, errors] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(generations).toBe(0);
    expect(`${output}\n${errors} (exit ${code})`).toContain("Blocked nonlocal provider request");
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
}, 60000);
