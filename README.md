# omo-mini

An independent, **read-only** local coding-agent CLI. It uses the public `@earendil-works/pi-agent-core` Agent and `@earendil-works/pi-ai` OpenAI-completions streaming adapter from the MIT Senpi/pi engine lineage. It is not an official OmO or Senpi distribution; it includes no OmO plugin, prompts, or launcher. See [THIRD_PARTY.md](THIRD_PARTY.md).

## Source install and run (Bun 1.4+)

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun link                  # register the local bin (no global OmO configuration changes)
omo-mini --help
bun dist/cli.js doctor --json
bun dist/cli.js run --root fixtures/tiny --task 'Find invoiceTotal; report file and line and what it adds' --json
```

`bun link` registers the independently executable `omo-mini` command in Bun's user bin directory; put that directory on `PATH` if necessary. Alternatively run the built entry directly. No OmO configuration, extension, session, or resource directory is loaded or written. Default base URL is `http://localhost:1234/v1`; `--base-url URL` and `--model ID` override it. The endpoint must serve `GET /api/v0/models` at the same origin and OpenAI-compatible streaming `POST /v1/chat/completions`. Only an already-loaded model advertising `tool_use` with `loaded_context_length` can be used; multiple eligible models require `--model`. There is no cloud fallback or model loading.

`doctor --json` returns endpoint reachability, selected model, and *loaded* context length. `run --root PATH --task TEXT --json` returns answer, tool results, observed file:line references, elapsed milliseconds, actual provider token usage when reported (otherwise null), request count, and stop/error reason. Non-stop results exit 1. JSON stdout contains only the result; image status is stderr. References are observed tool transcript references, **not** a guarantee that the answer cites them accurately. Never submit sensitive workspace content to an untrusted endpoint.

Read-only tools: literal case-insensitive workspace search and numbered file read. Canonical realpaths block escape through `..` and symlinks; search skips symlinks, common dependency/output directories, and files over 64 KiB. Results and turns are bounded (30 hits, 300 files, 12 KiB per result, 8 requests, 3 tool failures, 90-second deadline). The streaming boundary accounts for system prompt, tool schema, and message text before *every* request against the effective loaded context, with 2560 output-reserve units and framing overhead. Text uses a conservative UTF-8 **byte proxy**; images use a 1024-unit-per-512px-tile estimate rather than counting PNG base64 as text. These are not exact provider token counts. An image inside the 2 MiB / 16-megapixel attachment limits can still exceed the loaded model context budget. An oversized request fails explicitly rather than truncating a tool-call/result pair. No edit or shell tools are exposed.

## Clipboard and images (Windows)

`omo-mini run --root fixtures/tiny --task 'What words appear in the image?' --clipboard --json` reads the current Windows clipboard without changing it. Clipboard text, including Unicode newlines, is appended once to the task. If an image is also present it is encoded as a bounded PNG image attachment in the **same user message**; stderr shows image dimensions. An Explorer copy of exactly one PNG or JPEG file is also accepted: its actual image pixels are decoded to PNG without changing the clipboard. This explicit user attachment may come from outside `--root`; workspace file-read/search tools remain confined to `--root`. No file path is sent to the model. Multiple file entries, non-image files, missing files and failed decodes are errors. `--image image.png` attaches a PNG file inside `--root` (useful for public reproducible QA). Image input and encoded PNG must each be <= 2 MiB with dimensions <= 16 megapixels; clipboard text <= 64 KiB. File size is checked before opening a dropped file. Empty/unsupported clipboard, oversized data, and non-vision loaded models fail explicitly. No image path is sent as a substitute for image content.

Interactive mode (`bun dist/cli.js --root fixtures/tiny`) starts each submitted task with fresh history. `/paste` explicitly reads the Windows clipboard; `/quit` exits. Terminal-native Ctrl+V text paste works **when the terminal forwards text**; the program cannot intercept bindings consumed by the terminal. Bracketed paste is enabled while the terminal session is active so pasted multiline text is assembled as one task; a multiline native text chunk also stays one task. Press Enter to submit a bracketed paste. `/paste` is the reliable image-paste option. Interactive mode requires a TTY.

## Verification fixture

`fixtures/tiny/src/ledger.ts` contains `invoiceTotal` at line 1 and adds `base + handling` on line 2. `fixtures/tiny/image.png` displays **BLUE CAT 17** and is intentionally public. The smoke command for vision is:

```sh
bun dist/cli.js run --root fixtures/tiny --task 'Read the exact words and number printed in the attached image. Do not use tools.' --image image.png --json
```

CI checks typecheck, tests, and build on Ubuntu and Windows without requiring a local model or access to the user's clipboard; Windows exercises the PowerShell FileDrop decoder against generated public fixtures. Smoke evidence is in [docs/evidence/implementation.md](docs/evidence/implementation.md); independent real-surface evidence and the baseline/candidate report are in [docs/evidence/qa.md](docs/evidence/qa.md).

For sequential reproducible local evaluation, run `bun benchmarks/evaluate.ts` after build and with the loaded vision/tool-capable model already served by LM Studio. The driver copies only the public Tidewatch fixture into a temporary model root; oracle and task metadata remain outside. It evaluates 11 exact file questions plus the twelfth as an actual attached PNG visual question (decoded outside the model). It writes [docs/evidence/performance.json](docs/evidence/performance.json); `bun benchmarks/evaluate.ts --final-baseline` instead writes the independent post-fix [baseline rerun](docs/evidence/performance-final.json), including answer-only citation scoring, per-task latency/usage/request byte proxy, and valid/invalid tool calls. `--strategy grounded` is experimental; measured reliability favors default `baseline`. The latest local baseline passed 12/12 value checks but only 11/22 strict answer citation spans; value accuracy is not overall correctness or a citation guarantee. Model sampling, hardware load, and non-deterministic inference can change individual results.
