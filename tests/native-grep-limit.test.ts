import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool } from "../node_modules/@code-yeongyu/senpi/dist/core/tools/grep/index.js";

let base = "";
const previous = process.env["OMO_MINI_LOCAL_PROFILE"];
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "omo-mini-grep-limit-"));
  // 150 matching rows: above grep's default limit of 100.
  await writeFile(join(base, "events.log"), `${Array.from({ length: 150 }, (_, index) => `TRACE_REF=row-${index}`).join("\n")}\n`);
  process.env["OMO_MINI_LOCAL_PROFILE"] = "1";
});
afterEach(async () => {
  if (previous === undefined) delete process.env["OMO_MINI_LOCAL_PROFILE"];
  else process.env["OMO_MINI_LOCAL_PROFILE"] = previous;
  await rm(base, { recursive: true, force: true });
});
// The model-visible footer is the last text part of a grep result.
async function footer(pattern: string): Promise<string | undefined> {
  const result = await createGrepTool(base).execute("grep-limit", { pattern, path: "events.log" });
  const last = result.content.at(-1);
  return last?.type === "text" ? last.text : undefined;
}

test("Mini grep footer marks a result capped at its match limit", async () => {
  expect(await footer("TRACE_REF=")).toContain(" limitReached=true ");
});

test("Mini grep footer reports every matching line of a capped result", async () => {
  expect(await footer("TRACE_REF=")).toContain(" totalMatches=150 ");
});

test("Mini grep footer has no limit marker for a result under the limit", async () => {
  expect(await footer("TRACE_REF=row-7")).not.toContain("limitReached");
});
