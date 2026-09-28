import { expect, test } from "bun:test";
import { ReasoningRecovery } from "../src/reasoning-recovery.ts";

const plan = ["Check the supported script interface before selecting an execution method. ".repeat(3),
  "Use the observed result to choose a supported command and verify the output. ".repeat(3)];
const history = (timestamp: number) => [{ role: "assistant", timestamp }, { role: "toolResult", timestamp: timestamp + 1 }];

test("repeated substantial reasoning requests one correction for its own next call", () => {
  const recovery = new ReasoningRecovery();
  recovery.observe(1, plan);
  expect(recovery.consume(history(1))).toBe(false);
  recovery.observe(2, plan.map(part => part.replaceAll(" ", "  ")));
  expect(recovery.consume(history(99))).toBe(false);
  expect(recovery.consume(history(2))).toBe(true);
  expect(recovery.consume(history(2))).toBe(false);
  recovery.observe(2, plan);
  expect(recovery.consume(history(2))).toBe(false);
});

test("new evidence, short boilerplate and session reset do not trigger stale corrections", () => {
  const recovery = new ReasoningRecovery();
  recovery.observe(1, plan);
  recovery.observe(2, ["The tool result rules out that interface. Use the verified alternative instead. ".repeat(4)]);
  expect(recovery.consume(history(2))).toBe(false);
  recovery.observe(3, ["Checking the next file."]);
  recovery.observe(4, ["Checking the next file."]);
  expect(recovery.consume(history(4))).toBe(false);
  recovery.observe(5, plan);
  recovery.observe(6, plan);
  recovery.reset();
  expect(recovery.consume(history(6))).toBe(false);
  recovery.observe(7, plan);
  expect(recovery.consume(history(7))).toBe(false);
});

test("a changed introduction does not hide multiple copied reasoning paragraphs", () => {
  const recovery = new ReasoningRecovery();
  recovery.observe(1, ["First observation.\n\n" + plan.join("\n\n")]);
  recovery.observe(2, ["A recall note arrived.\n\n" + plan.join("\n\n")]);
  expect(recovery.consume(history(2))).toBe(true);
});

test("a summary request or new input cannot consume the tool continuation correction", () => {
  const recovery = new ReasoningRecovery();
  recovery.observe(1, plan);
  recovery.observe(2, plan);
  expect(recovery.consume([...history(2), { role: "user", timestamp: 4 }])).toBe(false);
  expect(recovery.consume(history(2))).toBe(true);
});
