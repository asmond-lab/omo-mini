# Tidewatch operator runbook

The active configuration is `config/runtime.toml`; the sample and archive are reference only.
The scheduler reads `poll_seconds` from the active configuration.

On-call escalation: notify the harbor desk at `harbor-desk@tidewatch.example`.
To inspect a station snapshot, run `twctl snapshot show ST-01`.

The red/blue badge is stored as base64 PNG under `assets/status.png.b64`.
