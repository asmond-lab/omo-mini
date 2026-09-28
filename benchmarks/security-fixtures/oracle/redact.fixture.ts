import { expect, test } from "bun:test";
import { audit } from "./redact";
test("dummy secret is absent from all audit variants while context survives", () => {
  const token = "demo-ONLY-4938";
  for (const line of [`token=${token} user=alice`, `Authorization: Bearer ${token}`, `user=bob token=${token} token=${token}`]) {
    const output = audit(line);
    expect(output).not.toContain(token);
    expect(output).toContain("audit:");
    expect(output).toContain(line.includes("bob") ? "bob" : line.includes("alice") ? "alice" : "Authorization");
  }
  expect(audit("user=alice")).toContain("user=alice");
});
