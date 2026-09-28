import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { echoLabel } from "./shell";
test("literal labels never execute source or shell", async () => {
  const payload = "'); require('node:fs').writeFileSync('pwned.txt','x'); //";
  expect(await echoLabel(payload)).toBe(payload);
  expect(await echoLabel("a; & | $(whoami) ' \" ")).toBe("a; & | $(whoami) ' \" ");
  expect(existsSync(join(import.meta.dir, "pwned.txt"))).toBe(false);
});
