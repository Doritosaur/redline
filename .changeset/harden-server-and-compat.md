---
'@redline/core': minor
'@redline/cli': minor
'@redline/mcp': minor
'@redline/server': minor
---

- server: route Chrome through a vetting proxy so redirects and subresources can't reach internal addresses; abort audits after a timeout; add `REDLINE_TRUST_PROXY` for rate limiting behind a reverse proxy.
- core: `audit()` accepts an `AbortSignal`, `runFlow()` accepts `chromeFlags`, and reports explain a large gap between traced LCP phases and the throttled LCP.
- core: fix `checkCompat` skipping every JS file when the scanned directory is outside the current working directory.
- core: honor `REDLINE_CHROME_FLAGS` for audits and flows (e.g. `--no-sandbox` in locked-down CI).
- mcp: split server construction from the stdio entry point so it can be tested.
