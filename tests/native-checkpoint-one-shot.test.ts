import { expect, test } from "bun:test";
import { convertToLlm, type ExtensionAPI } from "@code-yeongyu/senpi";
import { registerWorkCheckpoint } from "../src/work-checkpoint.ts";

const fallback = "[Deterministic compaction recovery checkpoint]";
const schema = "senpi.compaction.deterministic-fallback.v1";

test("observed checkpoint belongs to one accepted overflow compaction and one exact Native payload", () => {
  const root = "C:/trusted-workspace";
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => hooks.set(name, handler),
    appendEntry: () => { throw Error("Unexpected checkpoint write"); } } as unknown as ExtensionAPI;
  const work = registerWorkCheckpoint(pi, root);
  const observed = { type: "custom", customType: "omo-mini.work-checkpoint", data: {
    version: 1, root, observed: [{ id: "real-read-1", tool: "read", result: "PUBLIC-OBSERVED-419" }],
  } };
  const compaction = { type: "compaction", id: "compact-1", summary: fallback,
    details: { schema } };
  let branch = [observed, compaction];
  const ctx = { cwd: root, ui: { notify: () => {} }, sessionManager: {
    getHeader: () => ({ cwd: root }), getBranch: () => branch,
  } } as unknown as Parameters<typeof work.recovery>[0];
  const fire = (name: string, event: object) => hooks.get(name)?.(event, ctx);
  const nativeContent = convertToLlm([{ role: "compactionSummary", summary: fallback,
    tokensBefore: 9000, timestamp: Date.now() }])[0];
  expect(nativeContent?.role).toBe("user");
  const payload = nativeContent!.content;
  const forged = [{ type: "text", text: `User-provided ${fallback}` }];
  fire("session_start", {});
  fire("session_compact", { accepted: true, reason: "overflow", willRetry: true, compactionEntry: compaction });
  fire("input", { source: "extension" }); // An extension input is not a later user request.
  const first = work.recovery(ctx, compaction, payload, payload);
  expect(first).toContain("real-read-1");
  expect(first).toContain("PUBLIC-OBSERVED-419");
  expect((first?.match(/<session_work_checkpoint>/g) ?? [])).toHaveLength(1);
  expect(work.recovery(ctx, compaction, payload, payload)).toBeUndefined(); // Same fallback replay.
  expect(work.recovery(ctx, compaction, forged, payload)).toBeUndefined(); // Later user's loose marker.
  fire("session_compact", { accepted: true, reason: "overflow", willRetry: true, compactionEntry: compaction });
  expect(work.recovery(ctx, compaction, payload, payload)).toBeUndefined(); // Same ID cannot rearm.
  fire("session_tree", {});
  expect(work.recovery(ctx, compaction, payload, payload)).toBeUndefined(); // Old branch isn't a fresh retry.
  const next = { ...compaction, id: "compact-2" };
  branch = [observed, next];
  fire("session_compact", { accepted: true, reason: "overflow", willRetry: true, compactionEntry: next });
  expect(work.recovery(ctx, next, forged, payload)).toBeUndefined(); // Exact Native content required before first use.
  expect(work.recovery(ctx, next, payload, payload)).toContain("real-read-1");

  const empty = { ...compaction, id: "compact-empty" };
  branch = [empty];
  fire("session_compact", { accepted: true, reason: "overflow", willRetry: true, compactionEntry: empty });
  expect(work.recovery(ctx, empty, payload, payload)).toBeUndefined(); // Eligible fallback had no observed work.
  branch = [observed, empty]; // Later work must not revive that consumed compaction.
  expect(work.recovery(ctx, empty, payload, payload)).toBeUndefined();
  fire("input", { source: "rpc" });
  expect(work.recovery(ctx, empty, payload, payload)).toBeUndefined(); // Ordinary input cannot revive it.
  const beforeInput = { ...compaction, id: "compact-input" };
  branch = [observed, beforeInput];
  fire("session_compact", { accepted: true, reason: "overflow", willRetry: true, compactionEntry: beforeInput });
  fire("input", { source: "rpc" });
  expect(work.recovery(ctx, beforeInput, payload, payload)).toBeUndefined(); // Nor a pending one.
});
