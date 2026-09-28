import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";
import { chooseModel } from "../src/local.ts";

test("unloaded local models tell the user to load a model instead of selecting an absent instance", () => {
  const installed = { id: "qwen-local", state: "not-loaded", capabilities: ["tool_use"] };
  expect(() => chooseModel([installed])).toThrow("No model is loaded in LM Studio");
  expect(() => chooseModel([])).toThrow("Load a tool-capable chat model");
});

test("loaded but ineligible models explain missing capabilities or loaded context without bypassing admission", () => {
  expect(() => chooseModel([{ id: "embedding", state: "loaded", type: "embeddings" }])).toThrow("tool_use and loaded_context_length");
  expect(() => chooseModel([{ id: "qwen-local", state: "loaded", capabilities: ["tool_use"] }])).toThrow("tool_use and loaded_context_length");
});

test("doctor reports the unloaded model recovery instruction without attempting inference", async () => {
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname);
    return Response.json({ data: [{ id: "qwen-local", state: "not-loaded", capabilities: ["tool_use"] }] });
  } });
  const child = Bun.spawn([process.execPath, "src/cli.ts", "doctor", "--json", "--base-url", `http://127.0.0.1:${server.port}/v1`], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
  });
  try {
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = z.object({ error: z.object({ code: z.literal("model_selection"), message: z.string() }) }).parse(JSON.parse(output));
    expect(result.error.message).toContain("Load a tool-capable chat model");
    expect(result.error.message).not.toContain("use --model");
    expect(code).toBe(1);
    expect(errors).toBe("");
    expect(paths).toEqual(["/api/v0/models"]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    server.stop(true);
  }
});
