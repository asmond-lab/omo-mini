import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../node_modules/@code-yeongyu/senpi/dist/config.js";
import { FileHookStateStorage } from "../node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/hooks/trust-storage.js";

let base = "";
const previous = process.env["OMO_MINI_LOCAL_PROFILE"];
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "omo-mini-hooks-state-"));
  await mkdir(join(base, "agent"));
  await mkdir(join(base, "workspace"));
  process.env["OMO_MINI_LOCAL_PROFILE"] = "1";
});
afterEach(async () => {
  if (previous === undefined) delete process.env["OMO_MINI_LOCAL_PROFILE"];
  else process.env["OMO_MINI_LOCAL_PROFILE"] = previous;
  await rm(base, { recursive: true, force: true });
});
const storage = () => new FileHookStateStorage({ agentDir: join(base, "agent"), cwd: join(base, "workspace") });

test("Mini project hook-state read does not create the workspace config dir when it is absent", async () => {
  expect(storage().read("project")).toEqual({ version: 1, hooks: {} });
  expect(await readdir(join(base, "workspace"))).toEqual([]);
});

test("Mini still reads a user workspace project hooks-state.json snapshot", async () => {
  const entry = { enabled: false, scope: "project", sourcePath: "fixture/hooks.json", commandPreview: "echo fixture", updatedAt: "2026-09-28T00:00:00.000Z" } as const;
  await mkdir(join(base, "workspace", CONFIG_DIR_NAME));
  await writeFile(join(base, "workspace", CONFIG_DIR_NAME, "hooks-state.json"), JSON.stringify({ version: 1, hooks: { "fixture-hook": entry } }));
  expect(storage().read("project").hooks).toEqual({ "fixture-hook": entry });
});
