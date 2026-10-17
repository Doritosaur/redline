# Redline

Frontend performance audits for localhost and live URLs. Redline tells you **what to change in your code**, proves the change worked, and keeps it from regressing.

- **Ranked fixes**, not a wall of audits: Lighthouse findings ordered by estimated impact, with the element, URL, and the **source file or npm package** responsible (via source maps).
- **Trustworthy comparisons**: every run is saved; the next run shows what changed and separates real changes from run-to-run noise.
- **Budgets** that fail CI, with a PR comment showing what regressed and why.
- **Beyond Lighthouse**: Chromium/Firefox/WebKit measurements, browserslist compatibility checks, user flows with INP, and real-user Chrome UX Report data.
- **AI fixes**: `redline explain` sends the report and the flagged source files to Claude and returns prioritized code changes. In an AI editor, the MCP server lets the assistant measure, edit and re-measure itself.

## Quick start

```bash
npx @redline-dev/cli localhost:3000            # audit a dev server
npx @redline-dev/cli https://example.com --runs 3 --html report.html
```

Requires Node 22+ and Chrome (or Chromium) installed locally. In containers or locked-down CI where Chrome's sandbox can't start, set `REDLINE_CHROME_FLAGS="--no-sandbox"` (space-separated Chrome flags; applies to audits, flows and the server).

## Commands

| Command | What it does |
|---|---|
| `redline [url...]` | Audit pages. Compares with the previous run automatically. Options: `--runs`, `--preset mobile\|desktop`, `--html`, `--md`, `--json`, `--browsers`, `--compat`, `--field`, `--baseline <file>`, `--root <dir>`, `--no-save` |
| `redline compare <a.json> <b.json>` | Compare two saved results |
| `redline browsers <url>` | Load in Chromium, Firefox and WebKit; report timings, JS errors and failed requests per engine |
| `redline compat [dir]` | Find JS APIs and CSS features your browserslist targets don't support, with `file:line` |
| `redline flow [name...]` | Run scripted user flows from config and measure INP and where its time goes (input delay, processing, presentation) |
| `redline field <url>` | Real-user p75 Core Web Vitals from the Chrome UX Report (needs `CRUX_API_KEY`) |
| `redline explain [url...]` | Audit, then ask Claude for prioritized code-level fixes (needs Anthropic credentials) |
| `redline ci` | Audit configured pages against saved baselines; `--update-baseline` to save new ones |
| `redline init` | Create a `redline.config.ts` |

Exit codes: `0` ok · `1` error · `2` bad usage · `3` budget exceeded (or regression, with `failOnRegression`).

## Configuration

`redline.config.ts` (or `.mts`, `.js`, `.mjs`, `.json`), loaded from the current directory. TypeScript configs load natively on Node 22.18+.

```ts
export default {
  baseUrl: 'http://localhost:3000',
  pages: ['/', '/pricing'],
  sitemap: { url: '/sitemap.xml', limit: 50 }, // optional page discovery
                               // (sitemap and child-sitemap URLs are fetched as-is: only point at sites you trust)
  perTemplate: 2,              // audit at most 2 pages per route shape, e.g. /products/:id
  runs: 3,                     // medians; 3+ recommended for comparisons
  preset: 'mobile',
  budgets: { score: 80, lcp: 2500, cls: 0.1, tbt: 300 },
  failOnRegression: false,     // also fail CI on significant regressions within budget
  flows: [
    { name: 'Add to cart', url: '/products/1', steps: [{ click: '#add-to-cart' }, { wait: 500 }] },
  ],
  browsers: ['chromium', 'firefox', 'webkit'],
  projectRoot: '.',            // for mapping bundles back to source files
};
```

Flow steps: `{ click: selector }`, `{ type: { selector, text } }`, `{ press: key }`, `{ wait: ms }`, `{ scroll: px }`, `{ navigate: url }`.

Unknown keys are rejected, so typos like `lpc` fail loudly.

Run data lives in `.redline/`: `history/` (every run; add it to `.gitignore`) and `baseline/` (used by `redline ci`).

## Use from an AI editor (MCP)

```bash
claude mcp add redline -- npx -y @redline-dev/mcp
```

Tools: `audit_url`, `audit_project`, `compare_runs`, `cross_browser`, `check_compat`, `run_flow`, `field_data`. Pass `projectRoot` so findings map to your files. Then ask: *"Audit localhost:3000 with redline, fix the top issue, and verify it improved."* For `field_data`, set `CRUX_API_KEY` in the server's environment.

## CI (GitHub Actions)

See [`examples/github-workflow.yml`](examples/github-workflow.yml). The action runs `@redline-dev/cli@latest` by default; set `redline-version` to a fixed version for reproducible builds. The action starts your app, runs `redline ci`, posts a single PR comment that updates on each push, writes a job summary, uploads the HTML report, and fails the check on budget violations. Pushes to `main` save the baseline to the Actions cache, and PRs compare against it.

## AI explanations

`redline explain localhost:3000 --root .` uses `claude-opus-5-5` with server-side refusal fallbacks enabled. Credentials come from `ANTHROPIC_API_KEY` or an `ant auth login` profile. Only source files that the report points at are sent, up to 200 KB. Files outside `--root` are never read, and anything too large to send is listed in the output.

## Hosting

`@redline-dev/server` is a self-hostable audit service: a JSON API (`POST /api/audits`, `GET /api/audits/:id`), report pages and a minimal web UI. It runs one audit at a time, because concurrent Chrome runs skew each other's metrics.

```bash
docker build -t redline . && docker run --rm -p 8080:8080 --shm-size=1g redline
```

| Env var | Purpose |
|---|---|
| `REDLINE_API_TOKEN` | Require `Authorization: Bearer <token>` to start audits |
| `REDLINE_RATE_LIMIT` | Audits per client IP per hour (default 20) |
| `REDLINE_TRUST_PROXY=1` | Rate limit by the last `X-Forwarded-For` entry. Only behind a reverse proxy you control. Without it, clients behind a load balancer share one IP, so the limit becomes global |
| `REDLINE_ALLOW_PRIVATE=1` | Allow localhost/private URLs. **Only on a trusted network.** |
| `REDLINE_CHROME_FLAGS` | Extra Chrome flags (the image sets `--no-sandbox --disable-dev-shm-usage`) |

By default the server refuses URLs that resolve to private, loopback, link-local (cloud metadata) or reserved addresses. Chrome is routed through a built-in proxy that resolves and vets every destination, including redirects and subresources, and connects only to the vetted IP, so redirects and DNS rebinding can't reach internal services. Each audit is aborted after 2 minutes per run. As defence in depth, a public deployment should still run on a network with no route to internal services or metadata endpoints.

## Known limitations

- Lab metrics vary between runs. Use `--runs 3` or more before trusting small deltas; single-run comparisons are labelled as low confidence.
- Cross-browser numbers are unthrottled and machine-dependent, so they're for comparing engines, not for Core Web Vitals thresholds. Firefox and WebKit don't expose CLS.
- The compatibility check can't detect instance methods such as `array.toSorted()`, which need type information.
- On `localhost`, cache and compression findings are flagged as likely dev-server artifacts and ranked last.
- The Dockerfile hasn't been built in this repo's development environment yet.

## Develop

```bash
pnpm install
pnpm build        # tsc build for every package, in dependency order
pnpm test         # vitest
pnpm typecheck    # builds, then type-checks packages and tests
```

`fixtures/demo-app` is a deliberately slow site for end-to-end testing: `node fixtures/demo-app/serve.mjs` (add `FIXTURE_MODE=fast` for the fixed version).

| Package | |
|---|---|
| `@redline-dev/core` | Audit engine, diagnostics, comparison, budgets, config, multi-page, browsers, compat, flows, CrUX, reports |
| `@redline-dev/cli` | `redline` command |
| `@redline-dev/mcp` | MCP server |
| `@redline-dev/agent` | Claude-powered explanations |
| `@redline-dev/server` | Hosted audit service |

The npm packages are published under the `@redline-dev` scope; for example, install the CLI with `npx @redline-dev/cli`.

Notes: builds use plain `tsc` (TypeScript 7 removed the compiler API that tsup's declaration bundling needs), and pnpm blocks dependency install scripts except those listed under `allowBuilds` in `pnpm-workspace.yaml`.
