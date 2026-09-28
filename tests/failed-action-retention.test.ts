import { expect, test } from "bun:test";
import { FailedActionGuard } from "../src/policy.ts";

test("failed native read remains blocked after an unrelated successful shell search", () => {
  // Given a missing path caused a native read error.
  const guard = new FailedActionGuard();
  guard.call("missing", "read", { path: "missing.txt" });
  guard.result("missing", true);

  // When a different shell search succeeds.
  guard.call("search", "bash", { command: "rg --files" });
  guard.result("search", false);

  // Then retrying the unchanged read is still blocked.
  expect(guard.call("repeat", "read", { path: "missing.txt" })?.block).toBe(true);
});

test("failed native read can retry after its target state changes", () => {
  // Given the first read of a missing target failed.
  const guard = new FailedActionGuard();
  guard.call("missing", "read", { path: "missing.txt" }, { fileState: "missing" });
  guard.result("missing", true);

  // When the target is created, its supplied fingerprint changes.
  const retry = guard.call("created", "read", { path: "missing.txt" }, { fileState: "file:1:42" });

  // Then the read is admitted.
  expect(retry).toBeUndefined();
});

test("shell description and input order cannot evade a failed command", () => {
  // Given the command failed with a descriptive shell call.
  const guard = new FailedActionGuard();
  guard.call("failed", "bash", { command: "exit 49", timeout: 1000, description: "first phrasing" });
  guard.result("failed", true);

  // When the same execution fields arrive in a different order and description.
  const repeat = guard.call("repeat", "bash", { description: "second phrasing", timeout: 1000, command: "exit 49" });

  // Then the repeat remains blocked.
  expect(repeat?.block).toBe(true);
});

test("meaningful shell timeout change remains a distinct action", () => {
  // Given a command failed under one timeout.
  const guard = new FailedActionGuard();
  guard.call("failed", "powershell", { command: "exit 49", timeout: 1000 });
  guard.result("failed", true);

  // When its execution timeout changes.
  const retry = guard.call("retry", "powershell", { command: "exit 49", timeout: 2000 });

  // Then the different action is admitted.
  expect(retry).toBeUndefined();
});
