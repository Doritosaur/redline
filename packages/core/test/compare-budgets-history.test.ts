import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBudgets } from '../src/budgets.js';
import { compareResults } from '../src/compare.js';
import { historyKey, listRuns, loadLatestRun, readResult, saveRun } from '../src/history.js';
import { fakeResult } from './helpers.js';

const finding = (id: string) => ({ id, title: id, description: '', savings: {}, impact: 1, items: [] });

describe('compareResults', () => {
  it('separates real changes from noise', () => {
    const before = fakeResult({ lcp: 3000, tbt: 400, cls: 0.05, fcp: 1500 }, { score: 70 });
    const after = fakeResult({ lcp: 2100, tbt: 430, cls: 0.12, fcp: 1550 }, { score: 82 });
    const c = compareResults(before, after);
    const verdict = (id: string) => c.metrics.find((m) => m.id === id)?.verdict;

    expect(verdict('lcp')).toBe('improved'); // -900ms, well past 10%
    expect(verdict('tbt')).toBe('unchanged'); // +30ms < max(50ms, 20%)
    expect(verdict('cls')).toBe('regressed'); // +0.07 > 0.02
    expect(verdict('fcp')).toBe('unchanged'); // +50ms < 150ms (10%)
    expect(c.regressions).toEqual(['cls']);
    expect(c.improvements).toEqual(['lcp']);
    expect(c.scoreVerdict).toBe('improved');
    expect(c.metrics.find((m) => m.id === 'lcp')).toMatchObject({ ratingBefore: 'needs-improvement', ratingAfter: 'good' });
    expect(c.lowConfidence).toBe(false);
  });

  it('flags single-run comparisons as low confidence', () => {
    expect(compareResults(fakeResult({ lcp: 1000 }, { runs: 1 }), fakeResult({ lcp: 1000 })).lowConfidence).toBe(true);
  });

  it('reports new and resolved findings', () => {
    const before = fakeResult({}, { diagnostics: { findings: [finding('a'), finding('b')], layoutShifts: [], longTasks: [], sources: [] } });
    const after = fakeResult({}, { diagnostics: { findings: [finding('b'), finding('c')], layoutShifts: [], longTasks: [], sources: [] } });
    const c = compareResults(before, after);
    expect(c.newFindings).toEqual(['c']);
    expect(c.resolvedFindings).toEqual(['a']);
  });
});

describe('checkBudgets', () => {
  it('reports metrics over their limit and a score under the minimum', () => {
    const violations = checkBudgets(fakeResult({ lcp: 3000, cls: 0.05 }, { score: 72 }), { lcp: 2500, cls: 0.1, score: 90, tbt: 200 });
    expect(violations.map((v) => v.metric)).toEqual(['score', 'lcp']);
    expect(violations[1]).toMatchObject({ limit: 2500, actual: 3000 });
  });
});

describe('history', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => { dirs.splice(0).forEach((d) => { fs.rmSync(d, { recursive: true, force: true }); }); });

  it('keys runs by page and preset', () => {
    expect(historyKey('http://localhost:3000/products/1', 'mobile')).toBe('localhost_3000_products_1__mobile');
    const a = historyKey('http://localhost:3000/products/1?x=1', 'mobile');
    expect(a).toMatch(/^localhost_3000_products_1_q[0-9a-f]{8}__mobile$/);
    expect(a).not.toBe(historyKey('http://localhost:3000/products/1?x=2', 'mobile'));
    expect(historyKey('http://localhost:3000/products/1?a=1&b=2', 'mobile')).toBe(historyKey('http://localhost:3000/products/1?b=2&a=1', 'mobile'));
    expect(historyKey('https://example.com/', 'desktop')).toBe('example.com__desktop');
  });

  it('saves and loads runs in chronological order', () => {
    const dir = tmp();
    saveRun(fakeResult({ lcp: 2000 }, { fetchedAt: '2026-10-03T10:00:00.000Z' }), dir);
    saveRun(fakeResult({ lcp: 1500 }, { fetchedAt: '2026-10-03T11:00:00.000Z' }), dir);
    saveRun(fakeResult({ lcp: 9999 }, { preset: 'desktop' }), dir);

    expect(listRuns('https://example.com/', 'mobile', dir).map((r) => r.metrics[0]!.value)).toEqual([2000, 1500]);
    expect(loadLatestRun('https://example.com/', 'mobile', dir)?.metrics[0]?.value).toBe(1500);
    expect(loadLatestRun('https://example.com/other', 'mobile', dir)).toBeUndefined();
  });

  it('rejects files that are not audit results', () => {
    const file = path.join(tmp(), 'x.json');
    fs.writeFileSync(file, '{"hello": 1}');
    expect(() => readResult(file)).toThrow(/not a Redline audit result/);
  });

  it('reads UTF-8 with BOM and UTF-16 files (Windows PowerShell redirects)', () => {
    const dir = tmp();
    const json = JSON.stringify(fakeResult({ lcp: 1234 }));
    const bom8 = path.join(dir, 'utf8-bom.json');
    const le = path.join(dir, 'utf16le.json');
    const be = path.join(dir, 'utf16be.json');
    fs.writeFileSync(bom8, String.fromCharCode(0xfeff) + json);
    fs.writeFileSync(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]));
    fs.writeFileSync(be, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(json, 'utf16le').swap16()]));
    for (const file of [bom8, le, be]) expect(readResult(file).metrics[0]?.value).toBe(1234);
  });

  it('accepts a single-page `--json` report and rejects multi-page ones', () => {
    const dir = tmp();
    const one = path.join(dir, 'one.json');
    const two = path.join(dir, 'two.json');
    const result = fakeResult({ lcp: 777 });
    fs.writeFileSync(one, JSON.stringify({ generatedAt: 'x', pages: [{ result }] }));
    fs.writeFileSync(two, JSON.stringify({ generatedAt: 'x', pages: [{ result }, { result }] }));
    expect(readResult(one).metrics[0]?.value).toBe(777);
    expect(() => readResult(two)).toThrow(/report with 2 pages/);
  });

  it('explains files that are not JSON', () => {
    const file = path.join(tmp(), 'bad.json');
    fs.writeFileSync(file, 'not json');
    expect(() => readResult(file)).toThrow(/bad\.json is not valid JSON/);
  });
});
