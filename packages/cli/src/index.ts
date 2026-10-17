#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs, styleText } from 'node:util';
import {
  checkCompat,
  compareResults,
  fetchFieldData,
  hasFailures,
  loadConfig,
  measureAcrossBrowsers,
  readResult,
  renderHtml,
  renderMarkdown,
  resolvePages,
  runFlow,
  type LoadedConfig,
  type Preset,
  type RedlineReport,
} from '@redline-dev/core';
import { auditPages, looksLikeFilePath, normalizeUrl, writeBaseline, writeOutput } from './run.js';
import { bold, dim, green, red, renderBrowsers, renderCompat, renderField, renderFlow, renderPage, yellow } from './terminal.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

/** Exit codes: 0 ok, 1 error, 2 bad usage, 3 budgets failed (or regressions with failOnRegression). */
const EXIT = { ok: 0, error: 1, usage: 2, failed: 3 } as const;

class UsageError extends Error {}

const HELP = `${bold('redline')} - frontend performance audits for localhost and live URLs

${bold('Usage')}
  redline [audit] [url...]      Audit pages (default command). With no URL, audits pages from redline.config
  redline compare <a> <b>       Compare two saved results (.json)
  redline browsers <url>        Measure in Chromium, Firefox and WebKit
  redline compat [dir]          Find JS/CSS your browserslist targets don't support
  redline flow [name...]        Run user flows from redline.config and measure INP
  redline field <url>           Real-user Core Web Vitals from the Chrome UX Report
  redline explain [url...]      Audit, then ask Claude for prioritized code-level fixes
  redline ci                    Audit config pages against saved baselines; for CI
  redline init                  Create a redline.config.ts

${bold('Audit options')}
  -n, --runs <n>          Runs per page; metrics are medians (default 1, 3+ for reliable comparisons)
  -p, --preset <name>     mobile | desktop (default mobile)
      --root <dir>        Project source dir, for mapping bundles to files (default: config dir or cwd)
      --baseline <file>   Compare against this result instead of the previous run
      --no-save           Don't save the run to .redline/history
      --browsers          Also measure in Chromium, Firefox and WebKit
      --compat            Also check source compatibility (scans --root)
      --field             Also fetch Chrome UX Report data (needs CRUX_API_KEY)
      --json              Print the report as JSON
      --md <file>         Write a Markdown report
      --html <file>       Write a self-contained HTML report
  -c, --config <file>     Config file (default: redline.config.{ts,mts,js,mjs,json})

${bold('CI options')}
      --update-baseline   Save this run as the new baseline

${bold('Exit codes')}  0 ok · 1 error · 2 bad usage · 3 budget exceeded (or regression, with failOnRegression)

${bold('Examples')}
  redline localhost:3000 --runs 3
  redline https://example.com --preset desktop --html report.html
  redline explain localhost:3000 --root .
`;

const OPTIONS = {
  runs: { type: 'string', short: 'n' },
  preset: { type: 'string', short: 'p' },
  root: { type: 'string' },
  baseline: { type: 'string' },
  'no-save': { type: 'boolean', default: false },
  browsers: { type: 'boolean', default: false },
  compat: { type: 'boolean', default: false },
  field: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  md: { type: 'string' },
  html: { type: 'string' },
  config: { type: 'string', short: 'c' },
  'update-baseline': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

const COMMANDS = ['audit', 'compare', 'browsers', 'compat', 'flow', 'field', 'explain', 'ci', 'init'] as const;
type Command = (typeof COMMANDS)[number];

const log = (line: string) => process.stderr.write(`${dim(line)}\n`);
const out = (text: string): void => {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
};

type Handler = (args: string[], values: Values, loaded: LoadedConfig | undefined) => number | Promise<number>;

const HANDLERS: Record<Command, Handler> = {
  audit: cmdAudit,
  compare: (args) => cmdCompare(args),
  browsers: cmdBrowsers,
  compat: cmdCompat,
  flow: cmdFlow,
  field: cmdField,
  explain: cmdExplain,
  ci: (_args, values, loaded) => cmdCi(values, loaded),
  init: () => cmdInit(),
};

function parseCommand(positionals: string[]): { command: Command; args: string[] } {
  const first = positionals[0];
  const command: Command = COMMANDS.includes(first as Command) ? (first as Command) : 'audit';
  return { command, args: command === first ? positionals.slice(1) : positionals };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  if (values.help) return out(HELP), EXIT.ok;
  if (values.version) return out(version), EXIT.ok;

  const { command, args } = parseCommand(positionals);
  const loaded = command === 'init' ? undefined : await loadConfig(process.cwd(), values.config);
  if (loaded) log(`Using ${path.relative(process.cwd(), loaded.file) || loaded.file}`);
  return HANDLERS[command](args, values, loaded);
}

function parseRuns(values: Values, loaded: LoadedConfig | undefined): number {
  const runs = Number(values.runs ?? loaded?.config.runs ?? 1);
  if (!Number.isInteger(runs) || runs < 1) throw new UsageError(`--runs must be a positive integer, got "${values.runs}".`);
  return runs;
}

function parsePreset(values: Values, loaded: LoadedConfig | undefined): Preset {
  const preset = values.preset ?? loaded?.config.preset ?? 'mobile';
  if (preset !== 'mobile' && preset !== 'desktop') throw new UsageError(`--preset must be "mobile" or "desktop", got "${preset}".`);
  return preset as Preset;
}

function settings(values: Values, loaded: LoadedConfig | undefined) {
  const runs = parseRuns(values, loaded);
  const preset = parsePreset(values, loaded);
  return {
    runs,
    preset,
    projectRoot: path.resolve(values.root ?? loaded?.projectRoot ?? process.cwd()),
    historyDir: loaded?.historyDir ?? path.resolve('.redline'),
  };
}

async function pageUrls(args: string[], loaded: LoadedConfig | undefined): Promise<string[]> {
  const pathLike = args.find(looksLikeFilePath);
  if (pathLike) {
    throw new UsageError(`"${pathLike}" looks like a file, not a URL. --json takes no value (it prints JSON to stdout); use --md <file> or --html <file> to write a report.`);
  }
  if (args.length) return args.map(normalizeUrl);
  if (loaded) {
    const urls = await resolvePages(loaded.config);
    if (urls.length) return urls;
  }
  throw new UsageError('Missing <url>. Pass a URL, or add baseUrl/pages to redline.config.');
}

function requireCruxKey(values: Values): string | undefined {
  const cruxApiKey = values.field ? process.env.CRUX_API_KEY : undefined;
  if (values.field && !cruxApiKey) throw new UsageError('--field needs a Chrome UX Report API key in the CRUX_API_KEY environment variable.');
  return cruxApiKey;
}

async function addExtras(report: RedlineReport, urls: string[], values: Values, loaded: LoadedConfig | undefined): Promise<void> {
  const { runs, projectRoot } = settings(values, loaded);
  if (values.browsers) {
    log(`Measuring ${urls[0]} in ${(loaded?.config.browsers ?? ['chromium', 'firefox', 'webkit']).join(', ')}...`);
    report.browsers = { url: urls[0]!, runs: await measureAcrossBrowsers(urls[0]!, { browsers: loaded?.config.browsers, runs }) };
  }
  if (values.compat) {
    log(`Checking compatibility in ${projectRoot}...`);
    report.compat = await checkCompat(projectRoot);
  }
}

async function runConfigFlows(loaded: LoadedConfig, preset: Preset): Promise<NonNullable<RedlineReport['flows']>> {
  const results: NonNullable<RedlineReport['flows']> = [];
  for (const flow of loaded.config.flows ?? []) {
    log(`Running flow "${flow.name}"...`);
    results.push(await runFlow(flow, { baseUrl: loaded.config.baseUrl, preset }));
  }
  return results;
}

async function buildReport(args: string[], values: Values, loaded: LoadedConfig | undefined, ci = false): Promise<RedlineReport> {
  const s = settings(values, loaded);
  const urls = ci ? await pageUrls([], loaded) : await pageUrls(args, loaded);
  const cruxApiKey = requireCruxKey(values);

  const failures: NonNullable<RedlineReport['failures']> = [];
  const report: RedlineReport = {
    generatedAt: new Date().toISOString(),
    pages: await auditPages(urls, {
      onFailure: (url, message) => {
        failures.push({ url, message });
        log(`✖ ${url}: ${message}`);
      },
      ...s,
      ...(loaded?.config.budgets ? { budgets: loaded.config.budgets } : {}),
      save: !values['no-save'],
      ...(values.baseline ? { baselineFile: values.baseline } : {}),
      useBaselines: ci,
      ...(cruxApiKey ? { cruxApiKey } : {}),
      log,
    }),
  };
  if (failures.length === urls.length) throw new Error(failures[0]!.message);
  if (failures.length) report.failures = failures;
  await addExtras(report, urls, values, loaded);
  if (ci && loaded?.config.flows?.length) report.flows = await runConfigFlows(loaded, s.preset);
  return report;
}

function emit(report: RedlineReport, values: Values): void {
  if (values.md) writeOutput(values.md, renderMarkdown(report));
  if (values.html) writeOutput(values.html, renderHtml(report));
  if (values.json) { out(JSON.stringify(report, null, 2)); return; }

  for (const page of report.pages) out(renderPage(page));
  if (report.flows) for (const f of report.flows) out(renderFlow(f));
  if (report.browsers) out(renderBrowsers(report.browsers.url, report.browsers.runs));
  if (report.compat) out(renderCompat(report.compat));
  out('');
  if (report.failures) for (const f of report.failures) process.stderr.write(`${red(`✖ Not audited: ${f.url}`)} ${dim(f.message)}\n`);
  if (values.md) log(`Markdown report: ${path.resolve(values.md)}`);
  if (values.html) log(`HTML report: ${path.resolve(values.html)}`);
}

async function cmdAudit(args: string[], values: Values, loaded: LoadedConfig | undefined): Promise<number> {
  const report = await buildReport(args, values, loaded);
  emit(report, values);
  if (hasFailures(report)) return EXIT.failed;
  return report.failures ? EXIT.error : EXIT.ok;
}

async function cmdCi(values: Values, loaded: LoadedConfig | undefined): Promise<number> {
  if (!loaded) throw new UsageError('redline ci needs a redline.config with baseUrl/pages. Run `redline init` to create one.');
  const report = await buildReport([], { ...values, compat: values.compat }, loaded, true);
  // Always produce a Markdown summary in CI; the GitHub Action posts it as a PR comment.
  emit(report, { ...values, md: values.md ?? path.join(loaded.historyDir, 'report.md') });

  if (values['update-baseline']) {
    for (const page of report.pages) log(`Baseline saved: ${path.relative(process.cwd(), writeBaseline(page.result, loaded.historyDir))}`);
    return EXIT.ok;
  }
  const missing = report.pages.filter((p) => !p.comparison).length;
  if (missing) log(`${missing} page(s) have no baseline yet. Run \`redline ci --update-baseline\` on your main branch.`);
  const failed = hasFailures(report, { failOnRegression: loaded.config.failOnRegression ?? false });
  process.stderr.write(failed ? `${red('✖ Performance checks failed')}\n` : `${green('✔ Performance checks passed')}\n`);
  if (failed) return EXIT.failed;
  return report.failures ? EXIT.error : EXIT.ok;
}

function cmdCompare(args: string[]): number {
  const [a, b] = args;
  if (!a || !b) throw new UsageError('Usage: redline compare <before.json> <after.json>');
  const before = readResult(a);
  const after = readResult(b);
  const comparison = compareResults(before, after);
  out(renderPage({ result: after, comparison, violations: [] }, { findings: 0 }));
  if (comparison.newFindings.length) out(`\n${yellow('New issues:')} ${comparison.newFindings.join(', ')}`);
  if (comparison.resolvedFindings.length) out(`${green('Resolved:')} ${comparison.resolvedFindings.join(', ')}`);
  out('');
  return EXIT.ok;
}

async function cmdBrowsers(args: string[], values: Values, loaded: LoadedConfig | undefined): Promise<number> {
  const [url] = await pageUrls(args, loaded);
  const { runs } = settings(values, loaded);
  log(`Measuring ${url} in each browser...`);
  const results = await measureAcrossBrowsers(url!, { browsers: loaded?.config.browsers, runs });
  if (values.json) return out(JSON.stringify(results, null, 2)), EXIT.ok;
  out(renderBrowsers(url!, results));
  out('');
  return results.every((r) => r.error) ? EXIT.error : EXIT.ok;
}

async function cmdCompat(args: string[], values: Values, loaded: LoadedConfig | undefined): Promise<number> {
  const root = path.resolve(args[0] ?? values.root ?? loaded?.projectRoot ?? process.cwd());
  log(`Scanning ${root}...`);
  const report = await checkCompat(root);
  if (values.json) return out(JSON.stringify(report, null, 2)), EXIT.ok;
  out(renderCompat(report));
  out('');
  return EXIT.ok;
}

async function cmdFlow(args: string[], values: Values, loaded: LoadedConfig | undefined): Promise<number> {
  const flows = loaded?.config.flows ?? [];
  if (!flows.length) throw new UsageError('No flows defined. Add `flows` to redline.config (see `redline init`).');
  const selected = args.length ? flows.filter((f) => args.includes(f.name)) : flows;
  if (!selected.length) throw new UsageError(`No flow named ${args.join(', ')}. Available: ${flows.map((f) => f.name).join(', ')}`);
  const { preset } = settings(values, loaded);
  const results = [];
  for (const flow of selected) {
    log(`Running flow "${flow.name}"...`);
    results.push(await runFlow(flow, { baseUrl: loaded?.config.baseUrl, preset }));
  }
  if (values.json) return out(JSON.stringify(results, null, 2)), EXIT.ok;
  for (const r of results) out(renderFlow(r));
  out('');
  return EXIT.ok;
}

async function cmdField(args: string[], values: Values, loaded: LoadedConfig | undefined): Promise<number> {
  const apiKey = process.env.CRUX_API_KEY;
  if (!apiKey) throw new UsageError('Set CRUX_API_KEY to a Google API key with the Chrome UX Report API enabled.');
  const [url] = await pageUrls(args, loaded);
  const { preset } = settings(values, loaded);
  const data = await fetchFieldData(url!, { apiKey, preset });
  if (!data) {
    out(`No Chrome UX Report data for ${url} or its origin. CrUX only covers public sites with enough Chrome traffic.`);
    return EXIT.ok;
  }
  if (values.json) return out(JSON.stringify(data, null, 2)), EXIT.ok;
  out(['', ...renderField(data), ''].join('\n'));
  return EXIT.ok;
}

async function cmdExplain(args: string[], values: Values, loaded: LoadedConfig | undefined): Promise<number> {
  const { assertCredentials, explainReport, MissingCredentialsError } = await import('@redline-dev/agent');
  const { projectRoot } = settings(values, loaded);
  await assertCredentials().catch((err: unknown) => {
    throw err instanceof MissingCredentialsError ? new UsageError(err.message) : err;
  });
  const report = await buildReport(args, values, loaded);
  for (const page of report.pages) process.stderr.write(`${renderPage(page, { findings: 3 })}\n`);
  log('\nAsking Claude for fixes...\n');
  const result = await explainReport(report, { projectRoot, onText: (chunk: string) => process.stdout.write(chunk) });
  out('');
  log(`\n${result.model} · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens · ${result.includedFiles.length} source file(s) sent`);
  if (result.omittedFiles.length) log(`Not sent (too large): ${result.omittedFiles.join(', ')}`);
  if (values.md) writeOutput(values.md, `${result.markdown}\n`);
  return report.failures ? EXIT.error : EXIT.ok;
}

function cmdInit(): number {
  const file = path.resolve('redline.config.ts');
  if (fs.existsSync(file)) throw new UsageError(`${path.basename(file)} already exists.`);
  fs.writeFileSync(
    file,
    `// Redline configuration. Docs: redline --help
export default {
  baseUrl: 'http://localhost:3000',
  pages: ['/'],
  // sitemap: { url: '/sitemap.xml', limit: 50 },
  // perTemplate: 2,
  runs: 3,
  preset: 'mobile',
  budgets: {
    score: 80,
    lcp: 2500, // ms
    cls: 0.1,
    tbt: 300, // ms
  },
  failOnRegression: false,
  // flows: [
  //   { name: 'Add to cart', url: '/', steps: [{ click: '#add-to-cart' }, { wait: 500 }] },
  // ],
  // browsers: ['chromium', 'firefox', 'webkit'],
};
`,
  );
  out(`Created ${path.basename(file)}. Edit baseUrl and pages, then run: redline`);
  if (!fs.existsSync('.gitignore') || !fs.readFileSync('.gitignore', 'utf8').includes('.redline')) {
    out(dim('Tip: add .redline/history/ to .gitignore, and commit .redline/baseline/ if you use `redline ci`.'));
  }
  return EXIT.ok;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const usage = err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    process.stderr.write(`${styleText('red', 'Error:')} ${err instanceof Error ? err.message : String(err)}\n`);
    if (usage) process.stderr.write(dim('Run `redline --help` for usage.\n'));
    process.exitCode = usage ? EXIT.usage : EXIT.error;
  },
);
