import { styleText } from 'node:util';
import {
  formatBytes,
  formatDelta,
  formatMetric,
  formatMs,
  formatSavings,
  lcpPhaseNote,
  shortUrl,
  type BrowserRun,
  type CompatReport,
  type FieldData,
  type FlowResult,
  type PageReport,
  type Rating,
} from '@redline/core';

type Style = Parameters<typeof styleText>[0];
const RATING_STYLE: Record<Rating, Style> = { good: 'green', 'needs-improvement': 'yellow', poor: 'red' };
const RATING_TEXT: Record<Rating, string> = { good: 'good', 'needs-improvement': 'needs work', poor: 'poor' };

export const bold = (s: string) => styleText('bold', s);
export const dim = (s: string) => styleText('dim', s);
export const red = (s: string) => styleText('red', s);
export const green = (s: string) => styleText('green', s);
export const yellow = (s: string) => styleText('yellow', s);

function scoreStyle(score: number | null): 'dim' | 'green' | 'yellow' | 'red' {
  return score === null ? 'dim' : score >= 90 ? 'green' : score >= 50 ? 'yellow' : 'red';
}

export function renderPage(page: PageReport, options: { findings?: number } = {}): string {
  const { result, comparison } = page;
  const lines = [''];
  const score = result.score === null ? 'n/a' : String(result.score);
  const delta = comparison?.scoreDelta
    ? styleText(comparison.scoreVerdict === 'regressed' ? 'red' : comparison.scoreVerdict === 'improved' ? 'green' : 'dim', ` (${comparison.scoreDelta > 0 ? '+' : ''}${comparison.scoreDelta})`)
    : '';
  lines.push(`${bold(shortUrl(result.url))}  ${bold('score')} ${styleText(['bold', scoreStyle(result.score)], score)}${delta}`);
  lines.push(dim(`${result.finalUrl} · ${result.preset} · median of ${result.runs} run(s)${comparison ? ` · vs. ${comparison.before.fetchedAt.slice(0, 16).replace('T', ' ')}` : ''}`));
  lines.push('');

  const width = Math.max(...result.metrics.map((m) => m.label.length));
  for (const m of result.metrics) {
    const d = comparison?.metrics.find((x) => x.id === m.id);
    const change = d
      ? styleText(d.verdict === 'regressed' ? 'red' : d.verdict === 'improved' ? 'green' : 'dim', formatDelta(m.unit, d.delta).padStart(9))
      : '';
    lines.push(`  ${m.label.padEnd(width)}  ${formatMetric(m).padStart(8)}  ${change}${change ? '  ' : ''}${styleText(RATING_STYLE[m.rating], RATING_TEXT[m.rating])}`);
  }
  if (comparison?.lowConfidence) lines.push(dim('  Single-run comparison; differences may be noise. Use --runs 3 for reliable deltas.'));

  for (const v of page.violations) {
    const fmt = (n: number) => (v.metric === 'score' ? String(n) : v.metric === 'cls' ? n.toFixed(3) : formatMs(n));
    lines.push(red(`  ✖ ${v.label} ${fmt(v.actual)} exceeds budget ${v.metric === 'score' ? '≥' : '≤'} ${fmt(v.limit)}`));
  }

  if (page.field) lines.push('', ...renderField(page.field));

  const findings = result.diagnostics.findings.slice(0, options.findings ?? 5);
  if (findings.length) {
    lines.push('', bold('Top fixes'));
    findings.forEach((f, i) => {
      const savings = formatSavings(f.savings) || f.displayValue || '';
      if (f.devServerArtifact) {
        lines.push(dim(`  ${i + 1}. ${f.title}  (likely a dev-server artifact; check production headers)`));
        return;
      }
      lines.push(`  ${i + 1}. ${f.title}${savings ? `  ${styleText('red', savings)}` : ''}`);
      for (const item of f.items.slice(0, 2)) {
        const where = item.selector ?? (item.url ? shortUrl(item.url) : item.label);
        const src = item.sources?.[0];
        const from = src ? ` ← ${src.localPath ?? src.source.replace(/^.*node_modules\//, '')}${src.wastedBytes ? ` (${formatBytes(src.wastedBytes)} unused)` : ''}` : '';
        if (where || from) lines.push(dim(`     ${where ?? ''}${from}`));
        if (item.notes?.[0]) lines.push(dim(`     ${truncate(item.notes[0], 110)}`));
      }
    });
  }
  const lcp = result.diagnostics.lcpElement;
  if (lcp) {
    lines.push('', `${bold('LCP element')} ${lcp.selector}`, dim(`  ${lcp.phases.map((p) => `${p.phase} ${formatMs(p.ms)}`).join(' · ')}`));
    const note = lcpPhaseNote(lcp, result.metrics.find((m) => m.id === 'lcp')?.value);
    if (note) lines.push(dim(`  ${note}`));
  }
  return lines.join('\n');
}

export function renderField(field: FieldData): string[] {
  return [
    `${bold('Real users')} ${dim(`Chrome UX Report · ${field.scope} · ${field.formFactor.toLowerCase()}${field.collectionPeriod ? ` · ${field.collectionPeriod}` : ''}`)}`,
    ...field.metrics.map(
      (m) =>
        `  ${m.label.padEnd(26)} p75 ${(m.id === 'cls' ? m.p75.toFixed(2) : formatMs(m.p75)).padStart(8)}  ${styleText(RATING_STYLE[m.rating], RATING_TEXT[m.rating])}  ${dim(`${Math.round(m.distribution.good * 100)}% good`)}`,
    ),
  ];
}

export function renderBrowsers(url: string, runs: BrowserRun[]): string {
  const v = (n: number | null, cls = false) => (n === null ? dim('n/a') : cls ? n.toFixed(3) : formatMs(n));
  const lines = ['', `${bold('Cross-browser')} ${shortUrl(url)} ${dim('(unthrottled; compare engines with each other)')}`, ''];
  lines.push(dim(`  ${'browser'.padEnd(22)}${'TTFB'.padStart(9)}${'FCP'.padStart(9)}${'LCP'.padStart(9)}${'CLS'.padStart(8)}${'load'.padStart(9)}`));
  for (const r of runs) {
    const name = `${r.browser} ${r.version ?? ''}`.trim().padEnd(22);
    if (r.error) {
      lines.push(`  ${name}${yellow(r.error)}`);
      continue;
    }
    const cells = [v(r.metrics.ttfb), v(r.metrics.fcp), v(r.metrics.lcp)].map((c) => pad(c, 9)).join('') + pad(v(r.metrics.cls, true), 8) + pad(v(r.metrics.load), 9);
    lines.push(`  ${name}${cells}`);
    for (const e of [...r.errors, ...r.failedRequests].slice(0, 5)) lines.push(red(`    ✖ ${truncate(e, 120)}`));
  }
  return lines.join('\n');
}

export function renderCompat(report: CompatReport): string {
  const lines = ['', `${bold('Browser compatibility')} ${dim(`${report.targets.join(', ')} (${report.targetsSource}) · ${report.filesScanned} files`)}`];
  if (!report.issues.length) lines.push(green('  ✔ No unsupported features found.'));
  for (const i of report.issues) lines.push(`  ${yellow(`${i.file}:${i.line}:${i.column}`)}  ${i.message}`);
  for (const s of report.skipped) lines.push(dim(`  skipped ${s.file}: ${s.reason}`));
  if (report.issues.some((i) => i.kind === 'js')) {
    lines.push(dim('  Note: instance methods like array.toSorted() need type info and are not detected.'));
  }
  return lines.join('\n');
}

export function renderFlow(flow: FlowResult): string {
  const i = flow.interactions;
  const lines = ['', `${bold('Flow')} ${flow.name} ${dim(`· ${flow.steps.join(' → ')}`)}`];
  const inp = i.inp === null ? dim('no interaction registered') : `${styleText(RATING_STYLE[i.inpRating!], formatMs(i.inp))} ${dim(i.inpRating ?? '')}`;
  lines.push(`  INP ${inp}${i.inpTarget ? dim(` on ${i.inpTarget}`) : ''}`);
  if (i.inpBreakdown.length) lines.push(dim(`    ${i.inpBreakdown.map((p) => `${p.phase} ${formatMs(p.ms)}`).join(' · ')}`));
  lines.push(`  CLS during flow ${i.cls === null ? 'n/a' : i.cls.toFixed(3)}   TBT ${i.tbt === null ? 'n/a' : formatMs(i.tbt)}`);
  lines.push(dim(`  Initial load: score ${flow.navigation.score ?? 'n/a'}`));
  for (const f of i.findings.slice(0, 3)) lines.push(`  • ${f.title}${f.displayValue ? dim(` ${f.displayValue}`) : ''}`);
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** padStart that ignores ANSI escape codes when measuring. */
function pad(s: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return ' '.repeat(Math.max(0, width - visible)) + s;
}
