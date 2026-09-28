# Repeated reasoning recovery (2026-09-25)

## Diagnosis

The affected mini session contained identical 346–348-character thinking blocks in distinct assistant messages with different tool calls. One 347-character block appeared four times. Repetition was already present before the first memory recall notice. This establishes generation-level repetition; hiding duplicate terminal text would not correct the next model request. No user transcript or task-specific executable was used as a test fixture.

## Change

The mini extension compares substantial, whitespace-normalized reasoning paragraphs from consecutive completed tool steps. At least 160 repeated characters and 60% overlap of the shorter eligible block are required; short boilerplate does not qualify. Analysis is bounded to 16K characters per step.

The next matching model context receives one temporary instruction to reconsider the latest tool evidence, verify assumed capabilities and take a supported next action. A summary request with its own appended user message cannot consume the tool continuation's instruction. Original assistant reasoning, tool calls and results are retained. The instruction is not written to Native session history or durable memory. New input, session changes and model changes reset recovery state. This adds neither an arbitrary tool-step limit nor automatic command retries.

## Verification

- Unit tests cover substantial repetition, changed introductions, whitespace differences, short boilerplate, new evidence, one-time consumption and reset.
- An actual Native RPC process and loopback SSE provider reproduce two repeated synthetic thinking blocks separated by real native file reads. The next wire payload contains one recovery instruction; `get_messages` retains both original thinking blocks and read results without the instruction. The next user turn and a new session have no stale instruction.
- The loaded `qwen3.6-35b-local` model (65,536-token context) received a separate synthetic replay with two repeated plans, read results disproving an assumed plugin, and the recovery instruction. It completed in 27.8 seconds, reported that the plugin was unavailable and gave the observed `CEDAR-314` value, with no extra tool calls or exact copied plan. This verifies a bounded successful response, not a general improvement benchmark.
- Full regression run: 59 passed, 0 failed, 563 assertions across 22 files. After the additional summary-request safeguard, the affected unit and Native RPC tests passed again (5 tests, 27 assertions). Typecheck and both build outputs passed; the installed `omo-mini doctor --json` reached the same local model.

Model quality still matters: semantic repetition with different wording, repetition inside the first reasoning block, or a model ignoring feedback may continue. The extension does not hide these limitations or claim task completion. No LM Studio sampling defaults, original OmO Native memory or user session files were changed.
