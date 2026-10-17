# @redline/core

## 0.1.0

### Minor Changes

- 9e8cd69: - server: route Chrome through a vetting proxy so redirects and subresources can't reach internal addresses; abort audits after a timeout; add `REDLINE_TRUST_PROXY` for rate limiting behind a reverse proxy.
  - server: stop Chrome bypassing the vetting proxy for loopback and link-local addresses; bound the CONNECT handshake and idle plain-HTTP exchanges without cutting established tunnels; refuse every IPv6 form that embeds an IPv4 address (IPv4-compatible, mapped, SIIT, 6to4, Teredo, NAT64); expose `VettingProxy.port`.
  - core: history keys now include the query string, so `/search?q=a` and `?q=b` no longer share runs and baselines (parameter order is ignored) (existing history for URLs with query strings is not carried over).
  - agent: `explain` resolves symlinks so files outside `--root` are never sent, works when the root is a filesystem root, and lists every referenced file as omitted when the root can't be resolved.
  - core: `audit()` accepts an `AbortSignal`, `runFlow()` accepts `chromeFlags`, and reports explain a large gap between traced LCP phases and the throttled LCP.
  - core: fix `checkCompat` skipping every JS file when the scanned directory is outside the current working directory.
  - core: honor `REDLINE_CHROME_FLAGS` for audits and flows (e.g. `--no-sandbox` in locked-down CI).
  - mcp: split server construction from the stdio entry point so it can be tested.
  - core: stop printing Lighthouse's `mapping for column out of bounds` warnings about unusable third-party source maps on every run; `REDLINE_DEBUG=1` raises Lighthouse's log level.

### Patch Changes

- 6f5acce: Mark third-party findings and items, shorten long URLs in reports, explain "Unattributable" rows, and warn on single-run audits. The CLI rejects file paths passed as URLs (e.g. `--json out.json`), keeps finished pages when another page fails (exit 1), and `redline explain` checks Anthropic credentials before auditing.
- Initial public release of Redline MCP server and core dependency.
