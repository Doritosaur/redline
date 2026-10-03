import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Result } from 'lighthouse';
import { describe, expect, it } from 'vitest';
import { checkBudgets } from '../src/budgets.js';
import { compareResults } from '../src/compare.js';
import { summarize } from '../src/lighthouse.js';
import { renderHtml } from '../src/report/html.js';
import { MARKDOWN_MARKER, renderMarkdown } from '../src/report/markdown.js';
import { hasFailures, type RedlineReport } from '../src/report/model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const lhr = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/lhr-demo-slow.json'), 'utf8')) as Result;
const result = summarize('http://localhost:4321/', 'mobile', [lhr]);

function reportWith(overrides: Partial<RedlineReport> = {}): RedlineReport {
  const baseline = structuredClone(result);
  baseline.metrics = baseline.metrics.map((m) => (m.id === 'tbt' ? { ...m, value: 200 } : m));
  return {
    generatedAt: '2026-10-03T12:00:00.000Z',
    pages: [{ result, comparison: compareResults(baseline, result), violations: checkBudgets(result, { lcp: 2500, score: 90 }) }],
    ...overrides,
  };
}

describe('renderMarkdown', () => {
  const md = renderMarkdown(reportWith());

  it('starts with a marker so CI can update its own PR comment', () => {
    expect(md.startsWith(MARKDOWN_MARKER)).toBe(true);
  });

  it('shows budgets, metric changes and ranked fixes with source attribution', () => {
    expect(md).toContain('❌ 2 budget violations');
    expect(md).toMatch(/Total Blocking Time \| 1\.75 s \| \+1\.55 s ⚠️ \| 🔴/);
    expect(md).toContain('Improve image delivery');
    expect(md).toMatch(/Reduce unused JavaScript.*\n(.*\n)*.*lodash\/lodash\.js/);
    expect(md).toContain('📦 lodash');
  });
});

describe('budget status', () => {
  it('only claims budgets pass when budgets were actually checked', () => {
    const unchecked = renderMarkdown({ generatedAt: '2026-10-03T12:00:00.000Z', pages: [{ result, violations: [] }] });
    expect(unchecked).not.toContain('budgets pass');
    const checked = renderMarkdown({ generatedAt: '2026-10-03T12:00:00.000Z', pages: [{ result, violations: [], budgetsChecked: true }] });
    expect(checked).toContain('✅ All budgets pass');
  });
});

describe('renderHtml', () => {
  it('renders a self-contained document with no external requests', () => {
    const html = renderHtml(reportWith());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<(script|link)\b/i);
    expect(html).toContain('2 budget violations');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('escapes page-controlled content such as selectors and snippets', () => {
    const evil = structuredClone(result);
    evil.diagnostics.lcpElement = { selector: '<img src=x onerror=alert(1)>', snippet: '', phases: [] };
    const html = renderHtml({ generatedAt: '2026-10-03T12:00:00.000Z', pages: [{ result: evil, violations: [] }] });
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('hasFailures', () => {
  it('fails on budget violations, and on regressions only when asked', () => {
    expect(hasFailures(reportWith())).toBe(true);
    const regressedOnly = reportWith();
    regressedOnly.pages[0]!.violations = [];
    expect(hasFailures(regressedOnly)).toBe(false);
    expect(hasFailures(regressedOnly, { failOnRegression: true })).toBe(true);
  });
});
