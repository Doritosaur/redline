---
'@redline/core': patch
'@redline/cli': patch
'@redline/agent': patch
---

Mark third-party findings and items, shorten long URLs in reports, explain "Unattributable" rows, and warn on single-run audits. The CLI rejects file paths passed as URLs (e.g. `--json out.json`), keeps finished pages when another page fails (exit 1), and `redline explain` checks Anthropic credentials before auditing.
