import type { Rating } from '../types.js';
import {
  formatBytes,
  formatDelta,
  formatMetric,
  formatMs,
  formatSavings,
  lcpPhaseNote,
  learnMoreUrl,
  shortUrl,
  type PageReport,
  type RedlineReport,
} from './model.js';

const RATING_ICON: Record<Rating, string> = { good: '🟢', 'needs-improvement': '🟠', poor: '🔴' };
export const MARKDOWN_MARKER = '<!-- redline-report -->';

export interface MarkdownOptions {
  /** Findings listed per page. Default 5. */
  maxFindings?: number;
  /** Include source attribution, LCP element and layout shifts. Default true. */
  details?: boolean;
}

/** GitHub-flavored Markdown, suitable for PR comments, job summaries and LLM prompts. */
export function renderMarkdown(report: RedlineReport, options: MarkdownOptions = {}): string {
  const out: string[] = [MARKDOWN_MARKER, '## 🔴 Redline performance report', ''];
  const violations = report.pages.flatMap((p) => p.violations);
  const regressions = report.pages.filter((p) => p.comparison?.regressions.length);

  if (report.pages.length > 0) {
    if (violations.length) out.push(`**❌ ${violations.length} budget violation${violations.length === 1 ? '' : 's'}**`, '');
    else if (report.pages.some((p) => p.budgetsChecked)) out.push('**✅ All budgets pass**', '');
    if (regressions.length) out.push(`⚠️ Regressions on ${regressions.length} page${regressions.length === 1 ? '' : 's'} vs. baseline`, '');
  }
  if (report.pages.length > 1) out.push(...summaryTable(report.pages), '');
  for (const page of report.pages) out.push(...pageSection(page, options), '');
  if (report.flows?.length) out.push(...flowsSection(report), '');
  if (report.browsers) out.push(...browsersSection(report), '');
  if (report.compat) out.push(...compatSection(report), '');
  out.push(`<sub>Generated ${report.generatedAt} by Redline</sub>`);
  return out.join('\n');
}

function summaryTable(pages: PageReport[]): string[] {
  const rows = pages.map((p) => {
    const m = (id: string) => p.result.metrics.find((x) => x.id === id);
    const cell = (id: string) => {
      const metric = m(id);
      return metric ? `${RATING_ICON[metric.rating]} ${formatMetric(metric)}` : '–';
    };
    const delta = p.comparison?.scoreDelta;
    const score = `${p.result.score ?? 'n/a'}${delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}`;
    const status = p.violations.length ? '❌' : p.comparison?.regressions.length ? '⚠️' : '✅';
    return `| ${status} | \`${shortUrl(p.result.url)}\` | ${score} | ${cell('lcp')} | ${cell('tbt')} | ${cell('cls')} |`;
  });
  return ['| | Page | Score | LCP | TBT | CLS |', '|---|---|---|---|---|---|', ...rows];
}

type Finding = PageReport['result']['diagnostics']['findings'][number];

function violationLine(v: PageReport['violations'][number]): string {
  const actual = v.metric === 'score' ? String(v.actual) : v.metric === 'cls' ? v.actual.toFixed(3) : formatMs(v.actual);
  const limit = v.metric === 'score' ? `≥ ${v.limit}` : v.metric === 'cls' ? `≤ ${v.limit}` : `≤ ${formatMs(v.limit)}`;
  return `- ❌ **${v.label}** is ${actual}, budget ${limit}`;
}

function metricsTable(page: PageReport): string[] {
  const { result, comparison } = page;
  const out = [comparison ? '| Metric | Value | Change | |' : '| Metric | Value | |', comparison ? '|---|---|---|---|' : '|---|---|---|'];
  for (const metric of result.metrics) {
    const delta = comparison?.metrics.find((d) => d.id === metric.id);
    const change = delta ? `${formatDelta(metric.unit, delta.delta)}${delta.verdict === 'regressed' ? ' ⚠️' : delta.verdict === 'improved' ? ' ✅' : ''}` : '';
    out.push(`| ${metric.label} | ${formatMetric(metric)} | ${comparison ? `${change} |` : ''} ${RATING_ICON[metric.rating]} |`);
  }
  return out;
}

function fieldLine(page: PageReport): string[] {
  const field = page.field;
  if (!field) return [];
  return ['', `**Real users (Chrome UX Report, ${field.scope}${field.collectionPeriod ? `, ${field.collectionPeriod}` : ''})**: ` +
    field.metrics.map((m) => `${m.id.toUpperCase()} ${RATING_ICON[m.rating]} ${m.id === 'cls' ? m.p75.toFixed(2) : formatMs(m.p75)}`).join(' · ')];
}

function findingLines(f: Finding, i: number): string[] {
  const link = learnMoreUrl(f);
  const savings = formatSavings(f.savings);
  const artifact = f.devServerArtifact ? ' _(localhost: likely a dev-server artifact, verify against production)_' : '';
  const out = [`${i + 1}. **${link ? `[${f.title}](${link})` : f.title}**${savings ? ` — saves ${savings}` : f.displayValue ? ` — ${f.displayValue}` : ''}${artifact}`];
  for (const item of f.items.slice(0, 3)) {
    const where = item.selector ? `\`${item.selector}\`` : item.url ? `\`${shortUrl(item.url)}\`` : item.label ?? '';
    const srcs = (item.sources ?? []).slice(0, 2).map((s) => `\`${s.localPath ?? s.source.replace(/^.*node_modules\//, '')}\`${s.wastedBytes ? ` (${formatBytes(s.wastedBytes)} unused)` : ''}`);
    const note = item.notes?.[0];
    out.push(`   - ${[where, srcs.length ? `from ${srcs.join(', ')}` : '', note ?? ''].filter(Boolean).join(' — ')}`);
  }
  return out;
}

function baselineLines(page: PageReport): string[] {
  const { comparison } = page;
  const out: string[] = [];
  if (comparison?.newFindings.length) out.push('', `New issues since baseline: ${comparison.newFindings.map((f) => `\`${f}\``).join(', ')}`);
  if (comparison?.resolvedFindings.length) out.push('', `Resolved since baseline: ${comparison.resolvedFindings.map((f) => `\`${f}\``).join(', ')}`);
  return out;
}

function pageSection(page: PageReport, options: MarkdownOptions): string[] {
  const { result, comparison } = page;
  const out: string[] = [];
  const scoreDelta = comparison?.scoreDelta ? ` (${comparison.scoreDelta > 0 ? '+' : ''}${comparison.scoreDelta} vs. baseline)` : '';
  out.push(`### \`${shortUrl(result.url)}\` · score ${result.score ?? 'n/a'}${scoreDelta}`);
  out.push(`<sub>${result.finalUrl} · ${result.preset} · median of ${result.runs} run(s)${page.template ? ` · template \`${page.template}\`` : ''}</sub>`, '');

  for (const v of page.violations) out.push(violationLine(v));
  if (page.violations.length) out.push('');

  out.push(...metricsTable(page));
  if (comparison?.lowConfidence) out.push('', '<sub>Compared single runs; differences may be noise. Use `--runs 3` or more.</sub>');
  out.push(...fieldLine(page));

  const findings = result.diagnostics.findings.slice(0, options.maxFindings ?? 5);
  if (findings.length) {
    out.push('', '**Top fixes**', '');
    findings.forEach((f, i) => out.push(...findingLines(f, i)));
  }
  out.push(...baselineLines(page));

  if (options.details !== false) out.push(...detailsBlock(page));
  return out;
}

function lcpLines(page: PageReport): string[] {
  const el = page.result.diagnostics.lcpElement;
  if (!el) return [];
  const body = [`**LCP element:** \`${el.selector}\``, ''];
  if (el.phases.length) body.push(el.phases.map((p) => `${p.phase}: ${formatMs(p.ms)}`).join(' · '), '');
  const note = lcpPhaseNote(el, page.result.metrics.find((m) => m.id === 'lcp')?.value);
  if (note) body.push(`_${note}_`, '');
  return body;
}

function shiftLines(page: PageReport): string[] {
  const shifts = page.result.diagnostics.layoutShifts;
  if (!shifts.length) return [];
  const body = ['**Layout shifts**', ''];
  for (const s of shifts.slice(0, 5)) body.push(`- \`${s.selector}\` shifted ${s.score.toFixed(3)}${s.causes.length ? ` — ${s.causes.join('; ')}` : ''}`);
  body.push('');
  return body;
}

function longTaskLines(page: PageReport): string[] {
  const tasks = page.result.diagnostics.longTasks;
  if (!tasks.length) return [];
  const body = ['**Long tasks**', ''];
  for (const t of tasks.slice(0, 5)) body.push(`- ${formatMs(t.durationMs)} at ${formatMs(t.startMs)} in \`${shortUrl(t.url)}\``);
  body.push('');
  return body;
}

function sourceLines(page: PageReport): string[] {
  const sources = page.result.diagnostics.sources.slice(0, 10);
  if (!sources.length) return [];
  const body = ['**Largest JavaScript sources** (from source maps)', '', '| Source | Size | Unused |', '|---|---|---|'];
  for (const s of sources) {
    const name = s.package ? `📦 ${s.package}` : `\`${s.localPath ?? s.source}\``;
    body.push(`| ${name} | ${formatBytes(s.bytes)} | ${s.unusedBytes ? formatBytes(s.unusedBytes) : '–'} |`);
  }
  body.push('');
  return body;
}

function detailsBlock(page: PageReport): string[] {
  const body = [...lcpLines(page), ...shiftLines(page), ...longTaskLines(page), ...sourceLines(page)];
  return body.length ? ['', '<details><summary>Diagnostics</summary>', '', ...body, '</details>'] : [];
}

function flowsSection(report: RedlineReport): string[] {
  const out = ['### User flows', '', '| Flow | INP | Slowest phase | CLS during flow | TBT |', '|---|---|---|---|---|'];
  for (const f of report.flows ?? []) {
    const i = f.interactions;
    const slowest = [...i.inpBreakdown].sort((a, b) => b.ms - a.ms)[0];
    out.push(
      `| ${f.name} | ${i.inp === null ? 'no interaction' : `${RATING_ICON[i.inpRating!]} ${formatMs(i.inp)}`}${i.inpTarget ? ` on \`${i.inpTarget}\`` : ''} | ${slowest ? `${slowest.phase} ${formatMs(slowest.ms)}` : '–'} | ${i.cls?.toFixed(3) ?? '–'} | ${i.tbt === null ? '–' : formatMs(i.tbt)} |`,
    );
  }
  return out;
}

function browsersSection(report: RedlineReport): string[] {
  const b = report.browsers!;
  const v = (n: number | null, cls = false) => (n === null ? 'n/a' : cls ? n.toFixed(3) : formatMs(n));
  const out = [
    `### Cross-browser · \`${shortUrl(b.url)}\``,
    '<sub>Unthrottled, on the same machine: compare engines with each other, not with Core Web Vitals thresholds.</sub>',
    '',
    '| Browser | TTFB | FCP | LCP | CLS | Load | Errors |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of b.runs) {
    if (r.error) {
      out.push(`| ${r.browser} | ⚠️ ${r.error} | | | | | |`);
      continue;
    }
    const issues = r.errors.length + r.failedRequests.length;
    out.push(`| ${r.browser} ${r.version ?? ''} | ${v(r.metrics.ttfb)} | ${v(r.metrics.fcp)} | ${v(r.metrics.lcp)} | ${v(r.metrics.cls, true)} | ${v(r.metrics.load)} | ${issues ? `❌ ${issues}` : '✅'} |`);
  }
  for (const r of b.runs) for (const e of [...r.errors, ...r.failedRequests].slice(0, 5)) out.push(`- **${r.browser}:** ${e}`);
  return out;
}

function compatSection(report: RedlineReport): string[] {
  const c = report.compat!;
  const out = [`### Browser compatibility`, `<sub>Targets (${c.targetsSource}): ${c.targets.join(', ')} · ${c.filesScanned} files scanned</sub>`, ''];
  if (!c.issues.length) out.push('✅ No unsupported features found.');
  else {
    out.push('| Location | Feature | Issue |', '|---|---|---|');
    for (const i of c.issues.slice(0, 30)) out.push(`| \`${i.file}:${i.line}\` | ${i.feature} | ${i.message.replace(/\|/g, '\\|')} |`);
    if (c.issues.length > 30) out.push('', `…and ${c.issues.length - 30} more.`);
  }
  if (c.skipped.length) out.push('', `<sub>Skipped ${c.skipped.length} file(s) that could not be parsed.</sub>`);
  return out;
}
