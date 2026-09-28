# Native memory integration — 2026-09-25

omo-mini uses the installed OmO Native memory implementation, including reflection worktrees, committed memory, facts extraction, dream maintenance, search, recall, nudges and the compiled prompt cache. This reuses functionality, not existing OmO Native memory data.

## Isolation and local execution

- Default storage is `~/.omo-mini/memory/agents/<project-identity>/`. Sessions, agent configuration and HOME are also isolated under the mini state directory. Only mini conversations feed this memory.
- Every memory model category is pinned to the loaded `omo-mini-local` model. Sync is disabled; inherited Native profile/config selectors are removed. Conflicting project overrides are rejected.
- Read-only mode disables reflection, facts and dream writers. Recall defaults to one concurrent wake with a context-scaled budget capped at 16K tokens. Native's automatic reflection triggers remain 25 steps and compaction.
- Committed `system/` content is projected into subsequent conversations. Other memory files remain indexed and readable on demand. The local adapter resolves Native's `$MEMORY_DIR` placeholder to the actual mini repository, including Unicode project identities, and preserves projections above 4KB.

## Regression evidence

- Red: the old profile reported reflection disabled. Green: the actual Native reflection child read a failed command's transcript, wrote and committed lessons, and Native merged the commit into its memory repository.
- The same process started a fresh session and sent the committed self-awareness block, external-memory index and correct mini repository path to the local provider. The fixture uses a Korean project name; it verifies real child execution, clean merged Git state and projection, not a test-written substitute for reflection.
- Separate tests cover isolated original profiles, project identity boundaries, readonly writers, supported tuning, rejected model/sync overrides and inherited selector filtering.
- Red: projections above 4KB vanished. Green: structured content remains intact. Red: ASCII-only identity matching dropped Korean projects. Green: Unicode identities resolve inside the mini memory root, while path separators and traversal identities are rejected.
- Provider rejection tests count foreground generations separately from Native dream work, which now legitimately uses the same local endpoint.
- Final full suite: `bun test` — **55 pass, 0 fail, 538 assertions**, across 20 files (259.02 seconds). The Unicode projection/reflection follow-up also passed independently: 10 tests, 178 assertions. `bun run typecheck` and `bun run build` passed.

## Real local model evidence

The built CLI ran Native reflection using `omo-mini-local/qwen3.6-35b-local` against an existing mini tool-failure conversation. Native completed with `outcome: merged`, three changed files and a local memory commit after 510,548 ms. It created a Windows tool-routing reference and a reusable PowerShell skill in the mini memory repository.

The first fresh-session probe exposed a real integration defect: the model guessed a workspace `memory/` directory because the original projection contained an unresolved `$MEMORY_DIR`. Five `ENOENT` results correctly stopped that unfinished turn. The adapter path resolution and its Native regression test were added in response. The initial model-written lesson also over-attributed Bash expansion to Korean locale; a subsequent Native reflection received explicit QA feedback to correct unsupported claims.

That correction completed through Native with `outcome: merged`, three changed files, a second local memory commit, and duration 489,479 ms. The original Native memory profile was not used as a data source. After rebuilding, a new CLI session selected the actual mini reference path and its native `read` returned `isError: false`; it no longer guessed a workspace `memory/` folder. The model answered with `stopReason: stop`, explaining Bash expansion and the script-file workaround. Native's automatic `omo-kibitzer:recall` also delivered a `<recalled-memory>` note from the mini-generated PowerShell skill.

The CLI then reached `agent_end`, `agent_settled` and `agent_idle`, and exited with code 0. Bounded receipts remain in private QA storage; they are not distributed with this public document.

## Limits

Memory persistence and recall are provided by Native; lesson quality still depends on the local model and externally checked feedback. Not every failed call becomes a permanent rule or a promoted self-awareness entry. Native reflection on Windows currently runs without an OS sandbox when its sandbox policy is `auto`, as reported by Native itself.

One live recall sidecar reached Native's 90-second deadline without a completed model response, and the initial follow-up probe exceeded its 120-second harness timeout. The later CLI probe successfully read memory, answered and received automatic recall, so the observed limit is variable local-model latency rather than proof that recall is disabled. The deterministic fixture does not guarantee every real-model recall finishes before its deadline.
