import { expect, test } from "bun:test";
import { handle } from "./auth";
test("real loopback HTTP enforces key, not a query override", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const denied = await fetch(`${base}/private?x-demo-key=demo-key`);
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("private:report");
    const wrong = await fetch(`${base}/private`, { headers: { "x-demo-key": "wrong" } });
    expect(wrong.status).toBe(401);
    const allowed = await fetch(`${base}/private`, { headers: { "x-demo-key": "demo-key" } });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("private:report");
    expect((await fetch(`${base}/other`, { headers: { "x-demo-key": "demo-key" } })).status).toBe(404);
  } finally { server.stop(true); }
});
