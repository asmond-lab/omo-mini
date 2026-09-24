# Implementation smoke (2026-09-24)

Windows x64, Bun 1.4.0. The endpoint below was the user's already-running local OpenAI-compatible service; no local model was loaded or changed by this project. Model identifier and machine-specific paths are intentionally omitted from this public evidence.

- `bun run typecheck` -> exit 0.
- `bun test` -> deterministic local test suite exit 0 (tests include actual SDK streaming argument assembly through an in-process OpenAI-compatible HTTP server, schema/path boundaries, image wire serialization, budget guard, malformed stream, and cancellation).
- `bun run build` -> exit 0, built `dist/cli.js`.
- `bun dist/cli.js doctor --json` -> exit 0, `reachable=true`, `toolCapable=true`, `loadedContext=69376` at the time of the run.
- `bun dist/cli.js run --root fixtures/tiny --task 'Find invoiceTotal with the tools. Give path, line, and exact expression that computes the invoice total.' --json` -> exit 0, `reason=stop`; tool transcript searched and read `src/ledger.ts`; answer identified line 2 and `return base + handling;` (3 model requests; observed provider usage input 1661/output 186; elapsed 2484 ms in this run).
- `bun dist/cli.js run --root fixtures/tiny --task 'Read the exact words and number printed in the attached image. Do not use tools.' --image image.png --json` -> exit 0, `reason=stop`; answer `BLUE CAT 17`, matching public image (1 model request; observed provider usage input 493/output 152; elapsed 2083 ms in this run). The image status on stderr reported PNG 420x120.
- `bun dist/cli.js run --root fixtures/tiny --task 'Hi' --model NOT_LOADED --json` -> exit 1, error `model_unavailable` (no inference request).
- Read-only Windows clipboard adapter probe returned `status=readable`, text present and no image. Clipboard content was **not** sent to a model, printed, replaced, or published. Real image clipboard transfer and manual TTY interaction were not exercised; synthetic adapter and wire-image tests cover those interfaces separately. No performance comparison or sustained latency claim is made.

The output's `references` field enumerates observed file:line references in tool results, not independently validated citations inside answer prose. All public fixture content is synthetic.
