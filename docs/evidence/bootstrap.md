# Bootstrap evidence

Recorded 2026-09-24. These commands inspect public metadata and the local foundation; no model inference or package publication was performed.

- `gh repo view code-yeongyu/senpi --json nameWithOwner,url,licenseInfo,visibility,description` returned `code-yeongyu/senpi`, `PUBLIC`, and `MIT License` (exit 0).
- `gh api repos/code-yeongyu/senpi/contents/LICENSE --jq .content | base64 -d` returned the Senpi MIT notice reproduced in `THIRD_PARTY.md` (pipeline exit 0).
- `gh api repos/code-yeongyu/senpi/contents/packages/coding-agent/package.json --jq .content | base64 -d` identified package `@code-yeongyu/senpi` at version `2026.9.23-5` (inspection only; this foundation does not pin or install it).
- Before initialization, `C:/Users/123/Desktop/dev/omo-mini` was absent. `mkdir` succeeded, followed by `git init -b main` (exit 0). No pre-existing files were moved or overwritten.

The publication commit and remote verification are reported with their exact SHA and URL in the bootstrap handoff, since a commit cannot contain its own SHA.
