# Third-party licenses and modifications

**OmO Native** `omo-ai@5.0.0-0.beta.88` is the real runtime/plugin loaded by the independent `omo-mini` launcher. Upstream [code-yeongyu/oh-my-openagent LICENSE.md](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/LICENSE.md) is the **Sustainable Use License (SUL)**, not MIT. It permits personal/non-commercial use and free non-commercial distribution with its conditions and unaltered notices; commercial use/distribution is not granted by this project's MIT LICENSE. Preserve its upstream license and notices when distributing the dependency. The installed plugin's `LICENSE` grants MIT only to named LSP adapter portions, not to the entire plugin.

**Senpi** `@code-yeongyu/senpi@2026.9.23-5` is MIT (copyright 2025 Mario Zechner upstream pi-mono; copyright 2026 Yeongyu Kim and Senpi contributors). The former v0.1 historical engine dependencies `@earendil-works/pi-agent-core@0.87.1` and `@earendil-works/pi-ai@0.87.1` are MIT and remain for legacy tests, not as a substitute for actual OmO. Keep original dependency license/notice files with redistributed packages or bundles.

**Prominent modification notice:** omo-mini applies two **project-local** Bun `patchedDependencies`, documented in [docs/provider-rejection.md](docs/provider-rejection.md):
- `@code-yeongyu/senpi@2026.9.23-5`: explicit fail-closed `before_provider_request` rejection sentinel and type declaration; ordinary extension bugs still log.
- `omo-ai@5.0.0-0.beta.88`: launcher selects the pinned unbundled Senpi CLI so the project-local security patch is actually loaded. No installed global OmO files are modified.

The independent launcher and extension source in this repository have the repo's own MIT license, but the **combined OmO-backed distribution does not have an unrestricted MIT license**. Both license notices and the modification notice must travel with any free non-commercial redistribution that includes the OmO dependency.
