import { expect, test } from "bun:test";
import { accountQuery } from "./sql";
test("bound SQL keeps adversarial names out of statement", () => {
  for (const name of ["alice", "x' OR 1=1 --", "x'; DROP TABLE accounts;--"]) {
    const q = accountQuery(name);
    expect(q.sql).toBe("SELECT id FROM accounts WHERE username = ?");
    expect(q.params).toEqual([name]);
  }
});
