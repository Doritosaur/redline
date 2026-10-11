import { compareResults, type AuditResult, type BrowserRun, type CompatReport, type FlowResult, type PageReport } from '@redline/core';
import { describe, expect, it } from 'vitest';
import { renderBrowsers, renderCompat, renderFlow, renderPage } from '../src/terminal.js';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const result = (lcp: number, score: number, fetchedAt: string): AuditResult => ({
  url: 'https://example.com/',
  finalUrl: 'https://example.com/',
  fetchedAt,
  preset: 'mobile',
  runs: 3,
  score,
  lighthouseVersion: '13.5.0',
  metrics: [
    { id: 'lcp', label: 'Largest Contentful Paint', value: lcp, unit: 'ms', rating: lcp <= 2500 ? 'good' : 'poor', samples: [lcp, lcp, lcp] },
    { id: 'cls', label: 'Cumulative Layout Shift', value: 0.02, unit: 'unitless', rating: 'good', samples: [0.02, 0.02, 0.02] },
  ],
  diagnostics: {
    findings: [{ id: 'render-blocking', title: 'Eliminate render-blocking resources', severity: 'high', savings: { lcp: 900 }, items: [] } as never],
    layoutShifts: [],
    longTasks: [],
    sources: [],
  },
});

describe('renderPage', () => {
  it('shows the score, every metric with its rating, and budget violations', () => {
    const page: PageReport = {
      result: result(4000, 62, '2026-10-02T10:00:00.000Z'),
      violations: [{ metric: 'lcp', label: 'LCP', actual: 4000, limit: 2500 } as never],
    };
    const text = plain(renderPage(page));
    expect(text).toContain('score 62');
    expect(text).toContain('Largest Contentful Paint');
    expect(text).toContain('Cumulative Layout Shift');
    expect(text).toContain('poor');
    expect(text).toMatch(/exceeds budget ≤/);
    expect(text).toContain('Eliminate render-blocking resources');
  });

  it('shows deltas against the previous run and limits findings on request', () => {
    const before = result(4000, 62, '2026-10-01T10:00:00.000Z');
    const after = result(2000, 85, '2026-10-02T10:00:00.000Z');
    const text = plain(renderPage({ result: after, comparison: compareResults(before, after), violations: [] }, { findings: 0 }));
    expect(text).toContain('(+23)');
    expect(text).toContain('vs. 2026-10-01 10:00');
    expect(text).not.toContain('Eliminate render-blocking resources');
  });
});

describe('renderCompat', () => {
  const base: CompatReport = { root: '/p', targets: ['safari 14'], targetsSource: 'browserslist config', filesScanned: 4, issues: [], skipped: [] };

  it('celebrates a clean scan', () => { expect(plain(renderCompat(base))).toContain('No unsupported features found'); });

  it('lists file:line:column issues, skipped files and the JS caveat', () => {
    const text = plain(
      renderCompat({
        ...base,
        issues: [{ file: 'src/a.ts', line: 3, column: 9, kind: 'js', feature: 'structuredClone', message: 'structuredClone() is not supported in Safari 14' }],
        skipped: [{ file: 'src/b.js', reason: 'Parsing error' }],
      }),
    );
    expect(text).toContain('src/a.ts:3:9');
    expect(text).toContain('skipped src/b.js: Parsing error');
    expect(text).toContain('toSorted()');
  });
});

describe('renderBrowsers', () => {
  it('prints per-engine timings, errors, and failed requests', () => {
    const runs = [
      { browser: 'chromium', version: '130', metrics: { ttfb: 20, fcp: 300, lcp: 800, cls: 0.01, load: 900 }, errors: ['TypeError: x is not a function'], failedRequests: [] },
      { browser: 'webkit', version: null, error: 'Executable doesn’t exist', metrics: {}, errors: [], failedRequests: [] },
    ] as unknown as BrowserRun[];
    const text = plain(renderBrowsers('https://example.com/', runs));
    expect(text).toContain('chromium 130');
    expect(text).toContain('TypeError: x is not a function');
    expect(text).toContain('Executable doesn’t exist');
  });
});

describe('renderFlow', () => {
  it('summarizes INP with its breakdown, and handles no interaction', () => {
    const flow = {
      name: 'Add to cart',
      url: '/',
      preset: 'mobile',
      navigation: result(2000, 85, '2026-10-02T10:00:00.000Z'),
      steps: ['click #add', 'wait 300ms'],
      interactions: { inp: 640, inpRating: 'poor', cls: 0.012, tbt: 410, inpBreakdown: [{ phase: 'Processing duration', ms: 520 }], findings: [] },
    } as FlowResult;
    const text = plain(renderFlow(flow));
    expect(text).toContain('Add to cart');
    expect(text).toContain('click #add → wait 300ms');
    expect(text).toContain('Processing duration');
    expect(text).toContain('CLS during flow 0.012');

    const none = plain(renderFlow({ ...flow, interactions: { ...flow.interactions, inp: null, inpRating: null, inpBreakdown: [] } }));
    expect(none).toContain('no interaction registered');
  });
});
