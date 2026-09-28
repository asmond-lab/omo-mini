# Active-session tool-loop hardening — 2026-09-25

A reviewed private session sample of 400 entries contained 131 paired tool results, including 20 errors. The recent problem was not malformed JSON or unknown tool names. Identical successful Bash and native grep searches repeated at least six times before Native escalated, and missing-file reads re-executed after unrelated successful shell calls erased their failure records.

The sample included repeated successful Bash and grep observations and repeated missing-file reads. No original session commands were replayed; its call IDs and transcript remain in private QA records.

The active process started after the preceding build, so an old loaded extension did not explain these observations. This update changes the next loaded mini extension; it does not hot-patch the existing process.

## Behavior

- Canonical action keys ignore object property order and ignored Bash/PowerShell `description`, while retaining execution parameters such as timeout.
- Failed native file actions survive unrelated shell successes. Before each call the harness checks Native-resolved target metadata. Creating/changing the target allows a fresh execution.
- Two successful identical inspection observations produce a temporary provider-context recovery notice with the prior call ID and a bounded result excerpt. Variable Native grep timing metadata does not count as new information.
- A third identical regular-file inspection is blocked if its target metadata has not changed. Changed files, different queries/pages and new user requests can be inspected again.
- Shells and directory searches receive the early notice but are not hard-blocked by this new success guard. Their state can change outside the harness. Native's existing broader loop handling remains in place.
- Three consecutive ignored blocks of the same action stop that loop with an incomplete-work notice. Different actions do not share this counter.
- Guard state resets when a new user message is actually delivered to provider context, including a steer inside an already active agent run. The earlier before_agent_start-only reset missed this boundary.
- Original tool-call/result pairs remain in the native session. Recovery notices are request-local; no training or edits to original OmO or mini durable memory were performed.

## Verification

The native RPC regression uses a loopback fake OpenAI SSE provider and real mini launcher/native tools in an owned temporary workspace. Model output is scripted to reproduce the failure, so this verifies harness enforcement and provider delivery, not the real model's willingness to follow advice.

Before the fix, the third grep returned another successful fixture result. After the fix, native flags are `false,false,true,false,false` for grep/grep/blocked grep/write/grep: the third query is blocked and the post-edit query sees the changed fixture. Both repeated Bash observations remain successful and the next provider request carries the recovery notice.

A second sequence verifies missing read/error → unrelated Bash success → blocked read → Bash creates file → successful read. Every tool call retains its matching result ID. The compact wire evidence remains in private QA records and is not a public link.

Additional regressions cover Native Windows path aliases, changed metadata/results, query pagination, empty/error output, transient notices, and separate action counters. Both path normalization and counter fixes were observed failing before correction.

The active steering test held a provider request after two successful greps, queued a real RPC user steer, and verified exactly one agent_end. Before correction, the following grep was blocked; after correction all four tool results succeeded and the user message reached the next provider request.

- Full suite: 86 passed, 0 failed, 792 assertions across 29 files (169.87 seconds).
- Strict TypeScript check and build passed.
- Rebuilt dist CLI: 2 native RPC scenarios passed, 42 assertions (8.23 seconds), covering unchanged search blocking, post-edit verification, retained missing-file failure, shell-created file recovery, early shell notice and active steering.
- Installed `omo-mini --help` succeeds against the linked rebuilt entry.
- Existing memory reflection, compaction, selected session resume, cancellation, model selection and local-only provider boundaries all passed within the full suite.

The existing running process keeps its already-loaded extension until a reload or restart. Native TUI `/reload` reloads extensions while keeping the selected session; alternatively restart omo-mini and select the existing task with `/resume`.
