import type { Rating } from '../types.js';
import {
  formatBytes,
  formatDelta,
  formatMetric,
  formatMs,
  formatSavings,
  lcpPhaseNote,
  learnMoreUrl,
  plainDescription,
  compactUrl,
  describeLabel,
  isThirdPartyFinding,
  shortUrl,
  type PageReport,
  type RedlineReport,
} from './model.js';

const RATING_LABEL: Record<Rating, string> = { good: 'Good', 'needs-improvement': 'Needs work', poor: 'Poor' };

/** A single self-contained HTML file (no external assets), readable in light and dark mode. */
export function renderHtml(report: RedlineReport): string {
  const violations = report.pages.reduce((n, p) => n + p.violations.length, 0);
  const title = report.pages.length === 1 ? `Redline · ${shortUrl(report.pages[0]!.result.url)}` : 'Redline report';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style></head>
<body><main>
<header>
  <div class="brand"><span class="mark" aria-hidden="true"></span>Redline</div>
  <p class="meta">Generated ${esc(new Date(report.generatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</p>
</header>
${violations || report.pages.some((p) => p.budgetsChecked) ? `<p class="banner ${violations ? 'bad' : 'ok'}">${violations ? `${violations} budget violation${violations === 1 ? '' : 's'}` : 'All budgets pass'}</p>` : ''}
${report.pages.length > 1 ? summaryTable(report.pages) : ''}
${report.pages.map(pageSection).join('\n')}
${flowsSection(report)}
${browsersSection(report)}
${compatSection(report)}
</main></body></html>
`;
}

function summaryTable(pages: PageReport[]): string {
  const rows = pages
    .map((p, i) => {
      const cell = (id: string) => {
        const m = p.result.metrics.find((x) => x.id === id);
        return m ? `<td class="num"><span class="dot ${m.rating}"></span>${esc(formatMetric(m))}</td>` : '<td>–</td>';
      };
      return `<tr><td><a href="#page-${i}">${esc(shortUrl(p.result.url))}</a></td><td class="num">${scoreBadge(p.result.score)}</td>${cell('lcp')}${cell('tbt')}${cell('cls')}<td>${p.violations.length ? '<span class="pill poor">Over budget</span>' : p.comparison?.regressions.length ? '<span class="pill needs-improvement">Regressed</span>' : ''}</td></tr>`;
    })
    .join('');
  return `<section><h2>Pages</h2><div class="scroll"><table><thead><tr><th>Page</th><th>Score</th><th>LCP</th><th>TBT</th><th>CLS</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function metricRows(page: PageReport): string {
  const { result, comparison } = page;
  return result.metrics
    .map((m) => {
      const delta = comparison?.metrics.find((x) => x.id === m.id);
      const change = delta
        ? `<td class="num delta ${delta.verdict}">${esc(formatDelta(m.unit, delta.delta))}</td>`
        : comparison
          ? '<td></td>'
          : '';
      return `<tr><td>${esc(m.label)}</td><td class="num strong">${esc(formatMetric(m))}</td>${change}<td><span class="pill ${m.rating}">${RATING_LABEL[m.rating]}</span></td></tr>`;
    })
    .join('');
}

type Finding = PageReport['result']['diagnostics']['findings'][number];
type FindingItem = Finding['items'][number];

function findingItem(item: FindingItem): string {
  const where = item.selector ?? (item.url ? compactUrl(item.url) : describeLabel(item.label) ?? '');
  const sources = (item.sources ?? [])
    .slice(0, 3)
    .map((s) => `<code>${esc(s.localPath ?? s.source.replace(/^.*node_modules\//, ''))}</code>${s.wastedBytes ? ` ${esc(formatBytes(s.wastedBytes))} unused` : ''}`)
    .join(', ');
  return `<li>${where ? `<code>${esc(where)}</code>` : ''}${sources ? ` from ${sources}` : ''}${item.notes?.length ? `<div class="note">${esc(item.notes[0]!)}</div>` : ''}</li>`;
}

function findingHtml(f: Finding): string {
  const link = learnMoreUrl(f);
  const items = f.items.slice(0, 4).map(findingItem).join('');
  const savings = formatSavings(f.savings);
  const artifact = f.devServerArtifact ? '<div class="note">Localhost only: dev servers usually skip these headers. Verify against production.</div>' : '';
  const thirdParty = isThirdPartyFinding(f) ? '<div class="note">Third-party: defer or remove the tag; this is not your code.</div>' : '';
  return `<li class="finding${f.devServerArtifact ? ' muted-finding' : ''}"><div class="finding-head"><strong>${esc(f.title)}</strong>${savings ? `<span class="savings">${esc(savings)}</span>` : f.displayValue ? `<span class="savings">${esc(f.displayValue)}</span>` : ''}</div>${artifact}${thirdParty}
<p>${esc(plainDescription(f))}${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">Learn more</a>` : ''}</p>${items ? `<ul class="items">${items}</ul>` : ''}</li>`;
}

function violationsHtml(page: PageReport): string {
  return page.violations
    .map((v) => {
      const fmt = (n: number) => (v.metric === 'score' ? String(n) : v.metric === 'cls' ? n.toFixed(3) : formatMs(n));
      return `<li><strong>${esc(v.label)}</strong> is ${esc(fmt(v.actual))}; budget ${v.metric === 'score' ? '≥' : '≤'} ${esc(fmt(v.limit))}</li>`;
    })
    .join('');
}

function fieldHtml(page: PageReport): string {
  if (!page.field) return '';
  return `<h3>Real users <span class="sub">Chrome UX Report · ${esc(page.field.scope)}${page.field.collectionPeriod ? ` · ${esc(page.field.collectionPeriod)}` : ''}</span></h3>
<div class="field">${page.field.metrics
    .map(
      (m) => `<div class="field-metric"><div class="label">${esc(m.id.toUpperCase())} p75</div><div class="value"><span class="dot ${m.rating}"></span>${esc(m.id === 'cls' ? m.p75.toFixed(2) : formatMs(m.p75))}</div>
<div class="dist" role="img" aria-label="${pct(m.distribution.good)} good, ${pct(m.distribution.needsImprovement)} needs improvement, ${pct(m.distribution.poor)} poor"><span class="good" style="width:${pct(m.distribution.good)}"></span><span class="needs-improvement" style="width:${pct(m.distribution.needsImprovement)}"></span><span class="poor" style="width:${pct(m.distribution.poor)}"></span></div></div>`,
    )
    .join('')}</div>`;
}

function lcpHtml(page: PageReport): string {
  const el = page.result.diagnostics.lcpElement;
  if (!el) return '';
  const phases = el.phases.length ? `<div class="phases">${el.phases.map((p) => `<div><span class="label">${esc(p.phase)}</span><span class="num">${esc(formatMs(p.ms))}</span></div>`).join('')}</div>` : '';
  const note = lcpPhaseNote(el, page.result.metrics.find((m) => m.id === 'lcp')?.value);
  return `<h3>LCP element</h3><p><code>${esc(el.selector)}</code></p>${phases}${note ? `<p class="muted">${esc(note)}</p>` : ''}`;
}

function shiftsHtml(page: PageReport): string {
  const shifts = page.result.diagnostics.layoutShifts;
  if (!shifts.length) return '';
  return `<h3>Layout shifts</h3><ul class="plain">${shifts.slice(0, 5).map((s) => `<li><code>${esc(s.selector)}</code> <span class="num">${s.score.toFixed(3)}</span>${s.causes.length ? `<div class="note">${esc(s.causes.join('; '))}</div>` : ''}</li>`).join('')}</ul>`;
}

function sourcesHtml(page: PageReport): string {
  const sources = page.result.diagnostics.sources;
  if (!sources.length) return '';
  return `<h3>Largest JavaScript sources <span class="sub">from source maps</span></h3><div class="scroll"><table><thead><tr><th>Source</th><th class="num">Size</th><th class="num">Unused</th></tr></thead><tbody>${sources
    .slice(0, 12)
    .map((s) => `<tr><td>${s.package ? `<span class="pkg">package</span> ${esc(s.package)}` : `<code>${esc(s.localPath ?? s.source)}</code>`}</td><td class="num">${esc(formatBytes(s.bytes))}</td><td class="num">${s.unusedBytes ? esc(formatBytes(s.unusedBytes)) : '–'}</td></tr>`)
    .join('')}</tbody></table></div>`;
}

function pageMeta(page: PageReport): string {
  const { result, comparison } = page;
  return `${esc(result.finalUrl)} · ${esc(result.preset)} · median of ${result.runs} run${result.runs === 1 ? '' : 's'}${page.template ? ` · ${esc(page.template)}` : ''}${comparison?.scoreDelta ? ` · <span class="delta ${comparison.scoreVerdict}">${comparison.scoreDelta > 0 ? '+' : ''}${comparison.scoreDelta} vs. baseline</span>` : ''}`;
}

function pageSection(page: PageReport, index: number): string {
  const { result, comparison } = page;
  const findings = result.diagnostics.findings.slice(0, 8).map(findingHtml).join('');
  const violations = violationsHtml(page);
  return `<section class="page" id="page-${index}">
<div class="page-head">${scoreRing(result.score)}<div><h2>${esc(shortUrl(result.url))}</h2>
<p class="meta">${pageMeta(page)}</p></div></div>
${violations ? `<ul class="violations">${violations}</ul>` : ''}
<div class="scroll"><table class="metrics"><thead><tr><th>Metric</th><th class="num">Value</th>${comparison ? '<th class="num">Change</th>' : ''}<th>Rating</th></tr></thead><tbody>${metricRows(page)}</tbody></table></div>
${comparison?.lowConfidence ? '<p class="note">Compared single runs; small differences may be noise. Use --runs 3 or more.</p>' : ''}
${fieldHtml(page)}
${findings ? `<h3>Top fixes <span class="sub">ranked by estimated impact</span></h3><ol class="findings">${findings}</ol>` : '<p>No failing performance audits.</p>'}
<div class="grid2"><div>${lcpHtml(page)}</div><div>${shiftsHtml(page)}</div></div>
${sourcesHtml(page)}
</section>`;
}

function flowsSection(report: RedlineReport): string {
  if (!report.flows?.length) return '';
  const rows = report.flows
    .map((f) => {
      const i = f.interactions;
      const phases = i.inpBreakdown.map((p) => `${p.phase} ${formatMs(p.ms)}`).join(' · ');
      return `<tr><td>${esc(f.name)}</td><td class="num">${i.inp === null ? '–' : `<span class="dot ${i.inpRating}"></span>${esc(formatMs(i.inp))}`}</td><td>${i.inpTarget ? `<code>${esc(i.inpTarget)}</code>` : ''}<div class="note">${esc(phases)}</div></td><td class="num">${i.cls === null ? '–' : i.cls.toFixed(3)}</td><td class="num">${i.tbt === null ? '–' : esc(formatMs(i.tbt))}</td></tr>`;
    })
    .join('');
  return `<section><h2>User flows</h2><div class="scroll"><table><thead><tr><th>Flow</th><th class="num">INP</th><th>Slowest interaction</th><th class="num">CLS</th><th class="num">TBT</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function browsersSection(report: RedlineReport): string {
  if (!report.browsers) return '';
  const v = (n: number | null, cls = false) => (n === null ? '<span class="muted">n/a</span>' : esc(cls ? n.toFixed(3) : formatMs(n)));
  const rows = report.browsers.runs
    .map((r) =>
      r.error
        ? `<tr><td>${esc(r.browser)}</td><td colspan="6" class="muted">${esc(r.error)}</td></tr>`
        : `<tr><td>${esc(r.browser)} <span class="muted">${esc(r.version ?? '')}</span></td><td class="num">${v(r.metrics.ttfb)}</td><td class="num">${v(r.metrics.fcp)}</td><td class="num">${v(r.metrics.lcp)}</td><td class="num">${v(r.metrics.cls, true)}</td><td class="num">${v(r.metrics.load)}</td><td>${
            r.errors.length + r.failedRequests.length
              ? `<span class="pill poor">${r.errors.length + r.failedRequests.length} issue(s)</span>${[...r.errors, ...r.failedRequests].slice(0, 3).map((e) => `<div class="note">${esc(e)}</div>`).join('')}`
              : '<span class="pill good">None</span>'
          }</td></tr>`,
    )
    .join('');
  return `<section><h2>Cross-browser <span class="sub">${esc(shortUrl(report.browsers.url))} · unthrottled, compare engines with each other</span></h2><div class="scroll"><table><thead><tr><th>Browser</th><th class="num">TTFB</th><th class="num">FCP</th><th class="num">LCP</th><th class="num">CLS</th><th class="num">Load</th><th>Errors</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function compatSection(report: RedlineReport): string {
  const c = report.compat;
  if (!c) return '';
  const rows = c.issues
    .slice(0, 100)
    .map((i) => `<tr><td><code class="loc">${esc(`${i.file}:${i.line}`)}</code></td><td><span class="pkg">${i.kind}</span> ${esc(i.feature)}</td><td>${esc(i.message)}</td></tr>`)
    .join('');
  return `<section><h2>Browser compatibility <span class="sub">${esc(c.targets.join(', '))} · ${c.filesScanned} files</span></h2>${
    rows ? `<div class="scroll"><table><thead><tr><th>Location</th><th>Feature</th><th>Issue</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No unsupported features found.</p>'
  }</section>`;
}

function scoreRing(score: number | null): string {
  const rating = score === null ? 'none' : score >= 90 ? 'good' : score >= 50 ? 'needs-improvement' : 'poor';
  const deg = score === null ? 0 : (score / 100) * 360;
  return `<div class="ring ${rating}" style="--deg:${deg}deg" role="img" aria-label="Performance score ${score ?? 'not available'}"><span>${score ?? '–'}</span></div>`;
}

function scoreBadge(score: number | null): string {
  const rating = score === null ? 'none' : score >= 90 ? 'good' : score >= 50 ? 'needs-improvement' : 'poor';
  return `<span class="score ${rating}">${score ?? '–'}</span>`;
}

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1c1c1a;--muted:#6b6b66;--line:#e4e3de;--accent:#d92d20;
--good:#0f8a4f;--good-bg:#e3f4ea;--ni:#b35c00;--ni-bg:#fdf0dc;--poor:#c4261d;--poor-bg:#fde6e4;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1d1d1b;--fg:#ecebe6;--muted:#a3a29b;--line:#33332f;--accent:#ff6b5e;
--good:#4cc68a;--good-bg:#173527;--ni:#f0a64a;--ni-bg:#3a2a12;--poor:#ff7a70;--poor-bg:#3d1b18;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:64rem;margin:0 auto;padding:2rem 1rem 4rem}
header{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:.5rem;margin-bottom:1.5rem}
.brand{font-weight:700;font-size:1.25rem;display:flex;align-items:center;gap:.5rem}.mark{width:1.5rem;height:.3rem;background:var(--accent);border-radius:2px}
h2{font-size:1.2rem;margin:0}h3{font-size:1rem;margin:1.75rem 0 .6rem}.sub{font-weight:400;color:var(--muted);font-size:.85rem}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.25rem;margin:1rem 0}
section>h2{margin-bottom:.75rem}.meta,.muted,.note{color:var(--muted);font-size:.85rem}.note{margin-top:.2rem}
.banner{padding:.75rem 1rem;border-radius:10px;font-weight:600;margin:0 0 1rem}.banner.ok{background:var(--good-bg);color:var(--good)}.banner.bad{background:var(--poor-bg);color:var(--poor)}
.page-head{display:flex;gap:1rem;align-items:center;margin-bottom:1rem}.page-head .meta{margin:.2rem 0 0;overflow-wrap:anywhere}
.ring{--c:var(--muted);flex:none;width:4.5rem;height:4.5rem;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--c) var(--deg),var(--line) 0)}
.ring span{width:3.7rem;height:3.7rem;border-radius:50%;background:var(--card);display:grid;place-items:center;font-weight:700;font-size:1.3rem;color:var(--c)}
.ring.good,.score.good{--c:var(--good)}.ring.needs-improvement,.score.needs-improvement{--c:var(--ni)}.ring.poor,.score.poor{--c:var(--poor)}.score{color:var(--c);font-weight:700}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:.8rem}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.strong{font-weight:600}
.pill{display:inline-block;padding:.05rem .5rem;border-radius:999px;font-size:.78rem;font-weight:600;white-space:nowrap}
.pill.good{background:var(--good-bg);color:var(--good)}.pill.needs-improvement{background:var(--ni-bg);color:var(--ni)}.pill.poor{background:var(--poor-bg);color:var(--poor)}
.dot{display:inline-block;width:.55rem;height:.55rem;border-radius:50%;margin-right:.4rem;background:var(--muted)}.dot.good{background:var(--good)}.dot.needs-improvement{background:var(--ni)}.dot.poor{background:var(--poor)}
.delta.regressed{color:var(--poor)}.delta.improved{color:var(--good)}.delta.unchanged{color:var(--muted)}
.violations{background:var(--poor-bg);color:var(--poor);border-radius:10px;padding:.6rem 1rem .6rem 2rem;margin:0 0 1rem}
.findings{padding-left:1.4rem;margin:0}.muted-finding{opacity:.65}.finding{margin-bottom:1rem}.finding p{margin:.25rem 0;color:var(--muted);font-size:.88rem}
.finding-head{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap}.savings{color:var(--accent);font-weight:600;font-size:.85rem;font-variant-numeric:tabular-nums}
.items{margin:.3rem 0 0;padding-left:1.1rem;font-size:.85rem}.plain{list-style:none;padding:0;margin:0}.plain li{margin-bottom:.5rem}
code{font:.82rem ui-monospace,"Cascadia Code",Menlo,monospace;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:0 .3rem;overflow-wrap:anywhere}
code.loc{white-space:nowrap;overflow-wrap:normal}
.pkg{font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 .3rem}
.phases{display:grid;gap:.3rem}.phases div{display:flex;justify-content:space-between;gap:1rem;font-size:.88rem}.phases .label{color:var(--muted)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(18rem,1fr));gap:0 1.5rem}
.field{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem}.field-metric .label{color:var(--muted);font-size:.8rem}.field-metric .value{font-weight:600}
.dist{display:flex;height:.4rem;border-radius:2px;overflow:hidden;margin-top:.3rem;background:var(--line)}.dist .good{background:var(--good)}.dist .needs-improvement{background:var(--ni)}.dist .poor{background:var(--poor)}
a{color:var(--accent)}
`;
