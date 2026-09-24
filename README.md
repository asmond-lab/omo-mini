# omo-mini 0.2.0

**An independent local-model profile of real OmO Native**, not a separate read-only agent. The `omo-mini` launcher starts pinned `omo-ai@5.0.0-0.beta.88`, its OmO plugin, and pinned Senpi `2026.9.23-5`. A small explicit extension adapts the prompt, tool output, request budget and error feedback to the already-loaded Qwen model. The native OmO/Senpi TUI, coding tools, project instructions, permission system, session tree and image handling remain upstream-owned.

## Install and use

Requires Bun 1.4+, Node 24+, and an already-loaded tool/vision-capable model served locally at `http://127.0.0.1:1234/v1` (LM Studio's `/api/v0/models` discovery is required). No model loading or global OmO configuration is performed.

```sh
bun install --frozen-lockfile  # applies the two pinned project-local upstream patches
bun run typecheck
bun test
bun run build
bun link                   # optional: register this repo's omo-mini command
omo-mini doctor --json
omo-mini --root /path/to/workspace                # OmO native interactive TUI
omo-mini run --root fixtures/tiny --task 'Read src/ledger.ts and explain invoiceTotal' --json
omo-mini run --root fixtures/tiny --image image.png --task 'Transcribe this image' --json
omo-mini run --root fixtures/tiny --session my-task --task 'Continue the work' --json
```

The default state is `~/.omo-mini/{home,agent,sessions}`; override with `--state-dir PATH`. The process's `HOME`, `USERPROFILE`, OmO/Senpi agent directories, and session directory point there, so no installed `~/.omo` settings, credentials or sessions are adopted. `doctor` only discovers the local model and reports its ID, **loaded** context and canonical workspace without creating state. If several loaded tool-capable models exist, specify `--model ID`. `--base-url` accepts only a loopback HTTP `/v1` endpoint. The pinned model is re-discovered at every launch. The `run --session NAME` argument is a safe name under the mini session directory; ordinary `run` also uses upstream sessions. Interactive `/new` creates a distinct session; `/resume` opens existing project sessions. At narrow terminal widths, `/local-profile` displays the full canonical workspace root and selected local model in wrapped lines (the footer itself can ellipsize). `omo-mini rpc` exposes OmO's native JSONL RPC over standard input/output for integrations.

The native tool allowlist retains **read, grep, find, ls, bash, powershell, edit, write** (the OS determines which command tool is applicable). It drops cloud catalog and optional high-overhead extension tools, not normal coding. `workspace` is the default native permission preset; `--permission ask|read-only|workspace` selects another. Destructive `rm *` and `Remove-Item *` receive explicit deny rules. **Permissions are confirmation policy, not an OS sandbox**; approve only trusted workspaces/commands. Project context files (AGENTS.md/CLAUDE.md) remain enabled. Project-local executable resources require native trust; `--no-approve` prevents untrusted project settings/extensions loading. No cloud fallback, inherited cloud keys, bundled remote MCPs or cloud subagent catalog are enabled. Local-only provider and model identity are checked again at the *effective provider request*, with an intentional fail-closed rejection before HTTP. Telemetry and OmO LSP daemon are disabled for this compact profile. Built-in tools are still native, not sandboxed or reimplemented.

On Windows, the native TUI uses **Alt+V** for image or text clipboard paste. Ctrl+V works only when the terminal forwards it; omo-mini does not seize the terminal shortcut. The explicit `--image` option sends actual image pixels inside the model request. The user clipboard is never modified by omo-mini's setup or tests. The upstream TUI supplies multiline editor, status and session controls; no custom readline UI runs here. `run --json` writes native OmO JSONL events; if OmO's admission fails before any event or a turn ends empty/length/error, it adds an `omo_mini_status` JSON object and exits nonzero. Interactive abnormal endings are shown via extension notifications.

### Local capacity

The local profile sets model `contextWindow` to LM Studio's `loaded_context_length`, max output 2048, native compaction reserve/recent history 4096 each, a narrowed tool catalog and bounded tool results. Its pre-HTTP payload guard estimates conservatively from serialized size plus framing/output reserve; this is **not an exact tokenizer**. Long prompts or large images may be rejected before inference; the endpoint's own context rejection remains authoritative. No tool-call/result pair is manually spliced: native session compaction owns message retention. The loaded 69,376-context Qwen completed real read, edit/write/bash test, image and six-turn Korean session checks in [native QA](docs/evidence/native-qa.md). Cloud multi-agent workflows, external MCP servers, OmO LSP and the complete cloud skill catalog are not promised for this local profile.

Later [native release evidence](docs/evidence/native-release.md) records actual TUI, session, interruption and image-paste observations, including unresolved local-model limitations. The earlier native QA page records what had been verified at that date.

## Distribution and development

`omo-mini`'s own code has [LICENSE](LICENSE), but the combined installation is **not unrestricted MIT**: OmO upstream source is under the [Sustainable Use License](licenses/OmO-SUL-LICENSE.md) and has free non-commercial distribution and notice conditions. Senpi is [MIT](licenses/Senpi-MIT-LICENSE). Keep the original license/notice files with redistributed dependencies, observe OmO trademark and SUL limitations, and retain modification notices for the two pinned project-local patches. See [THIRD_PARTY.md](THIRD_PARTY.md) and [patch rationale](docs/provider-rejection.md). Do not install these patches globally.

Legacy v0.1 `src/run.ts`, `src/tools.ts`, and its old SDK tests remain as historical regression coverage but are **not** the main `omo-mini` command; new work should use upstream native tools and sessions. CI runs frozen install, typecheck, tests and build on Windows and Ubuntu without a local model. A real loaded-model check is available with `bun benchmarks/native-live.ts` (public prompts only; disposable state; prints structured evidence). Do not use private clipboard material as QA input.
