# omo-mini

An independent, **read-only** local coding-agent CLI. It uses the public `@earendil-works/pi-agent-core` Agent and `@earendil-works/pi-ai` OpenAI-completions streaming adapter from the MIT Senpi/pi engine lineage. It is not an official OmO or Senpi distribution; it includes no OmO plugin, prompts, or launcher. See [THIRD_PARTY.md](THIRD_PARTY.md).

## Source install and run (Bun 1.4+)

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun dist/cli.js --help
bun dist/cli.js doctor --json
bun dist/cli.js run --root fixtures/tiny --task 'Find invoiceTotal; report file and line and what it adds' --json
```

`package.json` declares `bin.omo-mini` at `dist/cli.js` for package-manager linking. Run the built entry directly as above without any global settings or package installation. No OmO configuration, extension, session, or resource directory is loaded or written. Default base URL is `http://localhost:1234/v1`; `--base-url URL` and `--model ID` override it. The endpoint must serve `GET /api/v0/models` at the same origin and OpenAI-compatible streaming `POST /v1/chat/completions`. Only an already-loaded model advertising `tool_use` with `loaded_context_length` can be used; multiple eligible models require `--model`. There is no cloud fallback or model loading.

`doctor --json` returns endpoint reachability, selected model, and *loaded* context length. `run --root PATH --task TEXT --json` returns answer, tool results, observed file:line references, elapsed milliseconds, actual provider token usage when reported (otherwise null), request count, and stop/error reason. Non-stop results exit 1. JSON stdout contains only the result; image status is stderr. References are observed tool transcript references, **not** a guarantee that the answer cites them accurately. Never submit sensitive workspace content to an untrusted endpoint.

Read-only tools: literal case-insensitive workspace search and numbered file read. Canonical realpaths block escape through `..` and symlinks; search skips symlinks, common dependency/output directories, and files over 64 KiB. Results and turns are bounded (30 hits, 300 files, 12 KiB per result, 8 requests, 3 tool failures, 90-second deadline). The streaming boundary checks the full serialized message/tool schema size before *every* request against the effective loaded context, with 1536 output-reserve units and framing overhead. This is a conservative UTF-8 **byte proxy**, not exact tokenization. An oversized request fails explicitly rather than truncating a tool-call/result pair. No edit or shell tools are exposed.

## Clipboard and images (Windows)

`omo-mini run --root fixtures/tiny --task 'What words appear in the image?' --clipboard --json` reads the current Windows clipboard without changing it. Clipboard text, including Unicode newlines, is appended once to the task. If an image is also present it is encoded as a bounded PNG image attachment in the **same user message**; stderr shows image dimensions. `--image image.png` attaches a PNG file inside `--root` (useful for public reproducible QA). Image bytes must be <= 2 MiB with dimensions <= 16 megapixels; clipboard text <= 64 KiB. Empty/unsupported clipboard, oversized data, and non-vision loaded models fail explicitly. No image path is sent as a substitute for image content.

Interactive mode (`bun dist/cli.js --root fixtures/tiny`) starts each submitted task with fresh history. `/paste` explicitly reads the Windows clipboard; `/quit` exits. Terminal-native Ctrl+V text paste works **when the terminal forwards text**; the program cannot intercept bindings consumed by the terminal. Bracketed paste is enabled while the terminal session is active so pasted multiline text is assembled as one task; a multiline native text chunk also stays one task. Press Enter to submit a bracketed paste. `/paste` is the reliable image-paste option. Interactive mode requires a TTY.

## Verification fixture

`fixtures/tiny/src/ledger.ts` contains `invoiceTotal` at line 1 and adds `base + handling` on line 2. `fixtures/tiny/image.png` displays **BLUE CAT 17** and is intentionally public. The smoke command for vision is:

```sh
bun dist/cli.js run --root fixtures/tiny --task 'Read the exact words and number printed in the attached image. Do not use tools.' --image image.png --json
```

CI checks typecheck, tests, and build without requiring a local model or access to the user's clipboard. Smoke evidence is in [docs/evidence/implementation.md](docs/evidence/implementation.md).
