# Third-party licenses and modifications

**OmO Native** `omo-ai@5.0.0-0.beta.88` is the real runtime/plugin loaded by the independent `omo-mini` launcher. Full upstream [Sustainable Use License (SUL)](licenses/OmO-SUL-LICENSE.md) from [code-yeongyu/oh-my-openagent LICENSE.md](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/LICENSE.md) accompanies this distribution; OmO as a whole is not MIT. It permits personal/non-commercial use and free non-commercial distribution with its conditions and unaltered notices; commercial use/distribution is not granted by this project's MIT LICENSE. Preserve its upstream license and notices when distributing the dependency. The installed plugin's `LICENSE` grants MIT only to named LSP adapter portions, not to the entire plugin.

**Senpi** `@code-yeongyu/senpi@2026.9.23-5` is [MIT](licenses/Senpi-MIT-LICENSE) (full text from [code-yeongyu/senpi LICENSE](https://github.com/code-yeongyu/senpi/blob/main/LICENSE); copyright 2025 Mario Zechner upstream pi-mono; copyright 2026 Yeongyu Kim and Senpi contributors). The former v0.1 historical engine dependencies `@earendil-works/pi-agent-core@0.87.1` and `@earendil-works/pi-ai@0.87.1` are MIT and remain for legacy tests, not as a substitute for actual OmO. Keep original dependency license/notice files with redistributed packages or bundles.

**Prominent modification notice:** omo-mini modifies two upstream packages, `@code-yeongyu/senpi@2026.9.23-5` and `omo-ai@5.0.0-0.beta.88`. The modifications are kept as patch files, `patches/@code-yeongyu%2Fsenpi@2026.9.23-5.patch` and `patches/omo-ai@5.0.0-0.beta.88.patch`, and Bun's `patchedDependencies` applies them to this project's local copies when `bun install` runs here. No installed global OmO or Senpi files are modified. Most changes take effect only in the omo-mini local profile: they check `OMO_MINI_LOCAL_PROFILE === "1"` or another `OMO_MINI_*` variable that the omo-mini launcher sets for its sessions. Changes marked *(all profiles)* apply whenever the patched package runs. Rationale: [docs/provider-rejection.md](docs/provider-rejection.md).

`@code-yeongyu/senpi@2026.9.23-5` (27 files; paths relative to the package root):
- `dist/core/extensions/runner.js`: *(all profiles)* a `before_provider_request` handler result `{ action: "reject", reason: string }` fails the request before transport, while ordinary handler exceptions are still logged and ignored; in the profile, handlers also receive the request's resolved model and headers.
- `dist/core/extensions/types.d.ts`: *(all profiles)* comment documenting that reject result.
- `dist/core/extensions/builtin/compaction/speculative-summary.js`: passes compaction summary request metadata to `before_provider_request`; the runner drops it outside the profile.
- `dist/core/extensions/builtin/compaction/deterministic-fallback.js`: the deterministic compaction checkpoint also carries the latest user request, verbatim and capped at 4096 bytes.
- `dist/core/agent-session.js`: retry fallback uses only the approved local chain in `OMO_MINI_LOCAL_FALLBACK` (none when unset); prompts fail with "No local model loaded" until a model is loaded; selecting or falling back to an `omo-mini-local` model loads it through the omo-mini model lifecycle module (cancellable by abort), re-registers the local provider with the loaded context size and rolls back on failure; concurrent model transitions are refused.
- `dist/core/sdk.js`: no initial model while none is loaded; `ls` and `find` join the default active tools; *(all profiles)* forwards the `fallbackNow` clock option to the session.
- `dist/core/sdk.d.ts`: *(all profiles)* declares the `fallbackNow` option.
- `dist/core/retry-fallback/controller.js`: *(all profiles)* after a fallback switch, reports and records as tried the model that is actually active, which local admission can resolve to a different loaded instance ID.
- `dist/modes/interactive/components/model-selector.js`: `/model` refresh lists the omo-mini local model catalog instead of refreshing provider registries.
- `dist/modes/interactive/interactive-mode.js`: terminal titles read `omo-mini`; the startup header uses `OMO_MINI_IDENTITY`; the resume hint uses `OMO_MINI_RESUME_HINT`; the `omo-native` footer badge is hidden; a loading status is shown while a local model loads.
- `dist/modes/rpc/connection-handler.js`: `set_model` answers asynchronously, so an abort is not queued behind a long local model load, and allows one selection at a time.
- `dist/modes/rpc/rpc-client.js`, `dist/modes/rpc/rpc-client.d.ts`: *(all profiles)* add `requestSession(command, sessionId)` to send a command to one explicitly addressed session.
- `dist/modes/rpc/rpc-types.d.ts`: *(all profiles)* adds the optional `if_idle` field to `close_session`.
- `dist/modes/rpc/session-command-router.js`: *(all profiles, opt-in)* `close_session` with `if_idle: true` returns `session_busy` unless the session is open, has exactly one attachment, and neither its worker nor its session is busy.
- `dist/modes/rpc/host-ensure.js`: a newly spawned RPC host gets 30 seconds instead of 10 to answer `get_protocol_info` before startup fails.
- `dist/main.js`: the startup loading label reads `omo-mini`.
- `dist/cli.js`: the process title reads `omo-mini`.
- `dist/core/project-trust.js`: the project trust prompt names `omo-mini`.
- `dist/core/extensions/builtin/hooks/trust-storage.js`: when the project hook-state directory does not exist, reading returns empty state without taking the lock, so running in a folder does not create `<cwd>/.omo`.
- `dist/utils/tools-manager.js`: the offline setting no longer disables on-demand `fd`/`rg` installation.
- `dist/core/tools/grep/index.js`: when a content search hits a match limit, a count-mode search over the same files adds `totalMatches`.
- `dist/core/tools/grep/format.js`: a capped result adds a "Match limit reached" note and `limitReached=true` / `totalMatches=N` footer fields.
- `dist/core/extensions/builtin/terminal/extension.js`: the background bash session tools (output, input, resize, kill) are exposed only inside `eval`.
- `dist/utils/clipboard-image.js`, `dist/utils/clipboard-image.d.ts`: *(all profiles)* on Windows, when the clipboard holds no image data, read one PNG/JPEG file copied in Explorer through PowerShell (at most 2 MiB and 16 megapixels) as PNG, without changing the clipboard; export `readFileDropImage`.
- `node_modules/@code-yeongyu/senpi-codemode/src/kernels/js/display-image.js` (bundled `@code-yeongyu/senpi-codemode`): a text-only tool result (`{ text }`) is displayed as plain text lines instead of one JSON line.

`omo-ai@5.0.0-0.beta.88` (4 files; paths relative to the package root):
- `bin/lib/package-paths.js`: *(all profiles)* always starts Senpi's unbundled `dist/cli.js` instead of the prelinked `dist/bundle/cli.js`, whose embedded runner is not patched.
- `bin/lib/launcher.js`: skips the interactive-start block that prints the omo-ai beta banner and the `omo setup` hint.
- `plugin/extensions/omo.js` (minified; the patch replaces its single code line): the project `.omo` config lookup and the config-migration directory walk stop at `OMO_MINI_NATIVE_HOME`; the memory `post-commit` hook skips the mirror push unless `OMO_MINI_NATIVE_MEMORY_SYNC=1`; thread tools use the peer host module named by `OMO_MINI_PEER_BRIDGE` instead of the shared Senpi thread host (and refuse to start without it), take its state directory and disk sessions, and release it at session shutdown; *(all profiles)* `thread_create` passes the caller's current model to the host's `openSession`.
- `plugin/extensions/omo-task.js` (minified; the patch replaces its single code line): the project `.omo` config lookup stops at `OMO_MINI_NATIVE_HOME`; *(all profiles)* the `task` tool refreshes the task runtime's session context from each call before running; *(all profiles)* a task RPC child running as a workpool worker (`OMO_SENPI_TASK_RPC_CHILD=1` with `OMO_WORKPOOL_STATE_DIR` or `OMO_WORKPOOL_TASK_ID` set) does not register the scheduler `workpool` tool.

The independent launcher and extension source in this repository have the repo's own MIT license, but the **combined OmO-backed distribution does not have an unrestricted MIT license**. Both license notices and the modification notice must travel with any free non-commercial redistribution that includes the OmO dependency.
