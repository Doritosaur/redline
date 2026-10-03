import type { BudgetViolation } from '../budgets.js';
import type { BrowserRun } from '../browsers.js';
import type { CompatReport } from '../compat.js';
import type { Comparison } from '../compare.js';
import type { FieldData } from '../crux.js';
import type { FlowResult } from '../flows.js';
import type { AuditResult, Finding, Metric, MetricSavings } from '../types.js';

export interface PageReport {
  result: AuditResult;
  /** URL template the page belongs to, e.g. /products/:id */
  template?: string;
  comparison?: Comparison;
  violations: BudgetViolation[];
  field?: FieldData;
}

/** Everything one Redline run produced; rendered as terminal output, Markdown or HTML. */
export interface RedlineReport {
  generatedAt: string;
  pages: PageReport[];
  browsers?: { url: string; runs: BrowserRun[] };
  compat?: CompatReport;
  flows?: FlowResult[];
}

export function hasFailures(report: RedlineReport, options: { failOnRegression?: boolean } = {}): boolean {
  return report.pages.some((p) => p.violations.length > 0 || (options.failOnRegression && (p.comparison?.regressions.length ?? 0) > 0));
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function formatMetric(metric: Pick<Metric, 'unit' | 'value'>): string {
  return metric.unit === 'unitless' ? metric.value.toFixed(3) : formatMs(metric.value);
}

export function formatDelta(unit: 'ms' | 'unitless', delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const abs = Math.abs(delta);
  return `${sign}${unit === 'unitless' ? abs.toFixed(3) : formatMs(abs)}`;
}

/** "LCP −1.2 s · TBT −300 ms · 49 KB" */
export function formatSavings(savings: MetricSavings): string {
  const parts: string[] = [];
  for (const key of ['lcp', 'fcp', 'tbt', 'inp'] as const) {
    if (savings[key]) parts.push(`${key.toUpperCase()} −${formatMs(savings[key])}`);
  }
  if (savings.cls) parts.push(`CLS −${savings.cls.toFixed(3)}`);
  if (savings.bytes) parts.push(formatBytes(savings.bytes));
  return parts.join(' · ');
}

/** Lighthouse descriptions end with "[Learn more](url)"; strip markdown links to plain text for terminals. */
export function plainDescription(finding: Finding): string {
  return finding.description.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s*Learn more.*$/i, '').trim();
}

export function learnMoreUrl(finding: Finding): string | undefined {
  return /\]\((https?:\/\/[^)]+)\)/.exec(finding.description)?.[1];
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
}
