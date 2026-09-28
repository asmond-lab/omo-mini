# Local reflection tool repair — 2026-09-25

## Observed failure

The original mini identity recorded real reflection failures: deadline expiry, a merge conflict, and `dirty_uncommitted` with ` D .tmp/parse_transcript.ps1`. In the last dirty run, the worker committed a temporary parser and then deleted it after the commit. Native correctly rejected the dirty completion. Its child also repeated Bash-to-PowerShell quoting and path failures while parsing the supplied JSON. The normal mini conversation extension was absent from this separate worker.

The existing manual run 10 subsequently completed with `no_changes` and `consecutiveFailures: 0`. That result did not persist a new lesson and predates the adapter. No original session, memory file, worktree, completion record, or failure counter was rewritten.

## Change

A mini-local wrapper uses Native's supported `OMO_MEMORY_RUN_SUPERVISOR_PATH` override. It validates the mini identity and worktree, changes only the reflection child tool route, and then imports the original supervisor in the same process. Native retains its process tracking, deadlines, terminal outcome, worktree validation, merge, and transcript cursor lifecycle. Dream keeps its original tool route and auxiliary inputs.

Reflection now receives native file tools and two structured tools:

- `reflection_input` parses the original payload, omits reasoning entries, and returns bounded pages with source IDs, `nextOffset`, and explicit field truncation. Default page size is 20 entries, capped at 40 and 12,000 serialized characters. It neither rewrites the transcript nor advances Native cursors.
- `reflection_commit` accepts exact relative Markdown paths within `system/`, `skills/`, `reference/`, or `notes/`. It refuses boundary changes, scratch paths, symlink traversal, pre-staged files, and unrelated dirt. It invokes Git with separate arguments and returns the actual commit SHA. Native still validates and merges the result.

The two guarded custom tools receive explicit permissions in this validated child only, so stricter Native permission presets do not block them. File-tool guidance supplies the actual worktree and literal relative paths instead of shell environment-variable syntax. The reflection child has no shell tool. Its file access checks use Native path expansion before worktree containment checks. Ordinary mini coding tools are unchanged. Existing failed-action and repeated-file guards also apply to this worker.

## Verification

- Whole regression suite: 98 tests passed, 0 failed, 849 assertions (182.32 seconds). Type checking and bundle build passed. The final built reflection integration was repeated after Native path validation changes: 1 pass, 39 assertions (11.79 seconds). After adding explicit permissions for the two custom tools, 13 related tests passed (79 assertions); the final built integration passed again (39 assertions, 12.34 seconds).

- Scripted Native RPC integration: failed observation → structured reader → two memory edits → exact-path commit → Native merged completion → clean repository → memory projection in a new session. Both source and built launcher passed 39 assertions. The raw wire evidence remains in private QA records and is not part of this public document.
- Helper tests cover pagination, escaped output, selected commits, unchanged repositories, staged/unrelated dirt, protected paths, symlinks, Windows aliases, and Native home expansion.
- Supervisor test preserves Native lifecycle fields, rejects mismatched identity/worktrees, and leaves dream launches unchanged.
- Final real-model probe: `qwen3.6-35b-a3b-uncensored-heretic-native-mtp-preserved` completed `reflection_input → read → edit → reflection_commit` in 17.18 seconds with zero tool errors. The committed Markdown correctly records that `public-check --mode old` failed with exit code 49 and `--mode current` succeeded. Only `system/self-aware.md` changed, the worktree was clean, and a temporary local memory commit was recorded. Earlier probe configuration failures and the assertion mismatch remain in the evidence.
- A separate public-fixture model probe was recorded in private QA evidence. It is a direct sidecar tool-use check; it does not replace the Native merge integration test or guarantee correctness on arbitrary prior conversations.

## Activation

New `omo-mini` launches use the built adapter. For an already-running session, wait for its current tool work to settle, run `/reload`, then use `/reflect` when a fresh reflection is wanted. An already-launched reflection worker retains its original launch plan.
