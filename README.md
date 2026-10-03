# Redline

Frontend performance audits for localhost and live URLs, built to grow into an agent that tells you **what to change in your code**, not just your score.

## Packages

| Package | What it is |
|---|---|
| `@redline/core` | Audit engine: runs Lighthouse in headless Chrome, normalizes metrics, rates them, takes medians across runs |
| `@redline/cli` | `redline <url>` command |
| `@redline/mcp` | MCP server exposing an `audit_url` tool to Claude Code, Cursor, etc. |

## Requirements

- Node 22+ (developed on Node 24 LTS)
- pnpm (version pinned in `packageManager`)
- Chrome or Chromium installed locally

## Develop

```bash
pnpm install
pnpm build        # tsc build for every package, in dependency order
pnpm test         # vitest
pnpm typecheck
```

## Use the CLI

```bash
pnpm redline localhost:3000
pnpm redline https://example.com --runs 3 --preset desktop
pnpm redline https://example.com --json > result.json
```

Exit codes: `0` success, `1` audit failed, `2` bad arguments.

## Use from Claude Code (MCP)

```bash
claude mcp add redline -- node /absolute/path/to/redline/packages/mcp/dist/index.js
```

Then ask: *"Audit localhost:3000 with redline and tell me what's hurting LCP."*

## Notes

- Built with plain `tsc` (TypeScript 7). tsup's declaration bundling depends on the pre-7 compiler API.
- pnpm blocks dependency install scripts by default; allowed ones are listed under `allowBuilds` in `pnpm-workspace.yaml`.
