import fs from 'node:fs';
import path from 'node:path';
import {
  audit,
  checkBudgets,
  compareResults,
  fetchFieldData,
  historyKey,
  loadLatestRun,
  readResult,
  saveRun,
  urlTemplate,
  type AuditResult,
  type Budgets,
  type FieldData,
  type PageReport,
  type Preset,
} from '@redline/core';

export interface PageAuditOptions {
  runs: number;
  preset: Preset;
  projectRoot: string;
  historyDir: string;
  budgets?: Budgets;
  /** Save each run to history. */
  save: boolean;
  /** Compare against this result file instead of history. */
  baselineFile?: string;
  /** CI mode: compare against `<historyDir>/baseline/<key>.json`. */
  useBaselines?: boolean;
  /** Fetch Chrome UX Report field data with this API key. */
  cruxApiKey?: string;
  /** Called when a page's audit throws; the run continues with the remaining pages instead of aborting. */
  onFailure?: (url: string, message: string) => void;
  log: (line: string) => void;
}

/** Audit each URL in turn, attaching comparison, budget results and field data. */
export async function auditPages(urls: string[], options: PageAuditOptions): Promise<PageReport[]> {
  const pages: PageReport[] = [];
  const explicitBaseline = options.baselineFile ? readResult(options.baselineFile) : undefined;
  for (const [i, url] of urls.entries()) {
    const label = urls.length > 1 ? `[${i + 1}/${urls.length}] ` : '';
    options.log(`${label}Auditing ${url} (${options.preset}, ${options.runs} run${options.runs === 1 ? '' : 's'})...`);
    try {
      pages.push(await auditOne(url, options, explicitBaseline));
    } catch (err) {
      // Without a failure handler the first error aborts; with one, finished pages are kept.
      if (!options.onFailure) throw err;
      options.onFailure(url, err instanceof Error ? err.message : String(err));
    }
  }
  return pages;
}

async function auditOne(url: string, options: PageAuditOptions, explicitBaseline: AuditResult | undefined): Promise<PageReport> {
  const baseline = explicitBaseline ?? (options.useBaselines ? readBaseline(url, options.preset, options.historyDir) : loadLatestRun(url, options.preset, options.historyDir));
  const result = await audit(url, {
    runs: options.runs,
    preset: options.preset,
    projectRoot: options.projectRoot,
    onProgress: (done, total) => {
      if (total > 1) options.log(`  run ${done}/${total} complete`);
    },
  });
  if (options.save) saveRun(result, options.historyDir);

  const page: PageReport = {
    result,
    template: urlTemplate(url),
    violations: options.budgets ? checkBudgets(result, options.budgets) : [],
    budgetsChecked: Boolean(options.budgets),
  };
  if (baseline) page.comparison = compareResults(baseline, result);
  const field = await fieldDataFor(url, options);
  if (field) page.field = field;
  return page;
}

async function fieldDataFor(url: string, options: PageAuditOptions): Promise<FieldData | undefined> {
  if (!options.cruxApiKey) return undefined;
  try {
    const field = await fetchFieldData(url, { apiKey: options.cruxApiKey, preset: options.preset });
    if (!field) options.log('  No Chrome UX Report data for this page or origin.');
    return field ?? undefined;
  } catch (err) {
    options.log(`  Field data unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

export function baselinePath(url: string, preset: Preset, historyDir: string): string {
  return path.join(historyDir, 'baseline', `${historyKey(url, preset)}.json`);
}

export function readBaseline(url: string, preset: Preset, historyDir: string): AuditResult | undefined {
  const file = baselinePath(url, preset, historyDir);
  return fs.existsSync(file) ? readResult(file) : undefined;
}

export function writeBaseline(result: AuditResult, historyDir: string): string {
  const file = baselinePath(result.url, result.preset, historyDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

export function writeOutput(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Catch `--json out.json`-style mistakes: a file path or output filename would otherwise be audited as a host. */
export function looksLikeFilePath(input: string): boolean {
  return /^[a-z]:[\\/]/i.test(input) || /^\.{0,2}[\\/]/.test(input) || /\.(json|md|html)$/i.test(input);
}

/** Let people type `localhost:3000` without a scheme. */
export function normalizeUrl(input: string): string {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
}
