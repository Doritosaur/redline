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
  /** True when budgets were configured and checked; otherwise "no violations" means nothing. */
  budgetsChecked?: boolean;
  field?: FieldData;
}

/** Everything one Redline run produced; rendered as terminal output, Markdown or HTML. */
export interface RedlineReport {
  generatedAt: string;
  pages: PageReport[];
  browsers?: { url: string; runs: BrowserRun[] };
  compat?: CompatReport;
  flows?: FlowResult[];
  /** Pages whose audit failed while others succeeded. */
  failures?: { url: string; message: string }[];
}

export function hasFailures(report: RedlineReport, options: { failOnRegression?: boolean } = {}): boolean {
  return report.pages.some((p) => p.violations.length > 0 || (options.failOnRegression && (p.comparison?.regressions.length ?? 0) > 0));
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/**
 * The LCP element and its phases come from the unthrottled trace, while the headline LCP is Lighthouse's throttled
 * simulation. When they differ a lot (a big image that only hurts on a slow network), say so rather than let the
 * two numbers look contradictory.
 */
export function lcpPhaseNote(lcp: { phases: { ms: number }[] } | undefined, lcpMetricMs: number | undefined): string | undefined {
  if (!lcp || !lcpMetricMs) return undefined;
  const observed = lcp.phases.reduce((sum, p) => sum + p.ms, 0);
  if (observed <= 0 || lcpMetricMs < observed * 2) return undefined;
  return `Measured without throttling (${formatMs(observed)}); the ${formatMs(lcpMetricMs)} LCP above is the throttled estimate, so a resource that is slow only on a slow network can differ from this element.`;
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

/** A URL for display in a line of text: path only when long, with the query string dropped and the path middle-cut to `max`. */
export function compactUrl(url: string, max = 90): string {
  const short = shortUrl(url);
  if (short.length <= max) return short;
  const noQuery = short.replace(/\?.*$/, '?…');
  return noQuery.length <= max ? noQuery : `${noQuery.slice(0, max - 1)}…`;
}

/** Lighthouse's catch-all row is opaque on its own; say what it means. */
export function describeLabel(label: string | undefined): string | undefined {
  if (!label) return label;
  return /^unattributable$/i.test(label) ? 'Unattributable (time not tied to any script URL: browser style/layout/GC work, or cross-origin iframes)' : label;
}

/** Every listed item comes from a third party, so the fix is deferring or removing a tag rather than editing your code. */
export function isThirdPartyFinding(finding: Finding): boolean {
  return finding.items.length > 0 && finding.items.every((i) => i.thirdParty);
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url;
  }
}
