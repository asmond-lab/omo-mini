import { expect, test } from "bun:test";
import { recover } from "./recover";
test("at most one primary attempt, then ordered alternatives", async () => {
  const calls: string[] = [];
  expect(await recover(async () => { calls.push("primary"); return false; }, [async () => { calls.push("alt1"); return false; }, async () => { calls.push("alt2"); return true; }])).toBe(true);
  expect(calls).toEqual(["primary", "alt1", "alt2"]);
});
test("bounded exhaustion and primary success", async () => {
  let count = 0;
  expect(await recover(async () => { count++; return false; }, [])).toBe(false);
  expect(count).toBe(1);
  expect(await recover(async () => true, [async () => { throw new Error("unreachable"); }])).toBe(true);
});
