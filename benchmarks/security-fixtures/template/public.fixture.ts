import { expect, test } from "bun:test";
import { accountQuery } from "./sql";
import { document } from "./path";
import { echoLabel } from "./shell";
import { handle } from "./auth";
import { audit } from "./redact";
import { recover } from "./recover";

test("SQL uses bound parameters", () => { const q = accountQuery("alice"); expect(q.sql).toContain("?"); expect(q.params).toEqual(["alice"]); });
test("document reads a normal local file", async () => { expect(await document(import.meta.dir, "note.txt")).toBe("hello\n"); });
test("shell passes a label as data", async () => { expect(await echoLabel("hello world")).toBe("hello world"); });
test("private HTTP resource requires a key", () => { expect(handle(new Request("http://127.0.0.1/private")).status).toBe(401); });
test("audit masks a dummy token", () => { expect(audit("token=demo-ONLY-4938")).not.toContain("demo-ONLY-4938"); });
test("retry switches after failure", async () => { let n = 0; expect(await recover(async () => { n++; return false; }, [async () => true])).toBe(true); expect(n).toBe(1); });
