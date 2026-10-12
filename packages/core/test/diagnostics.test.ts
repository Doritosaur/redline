import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Result } from 'lighthouse';
import { describe, expect, it } from 'vitest';
import { extractDiagnostics, impactScore, mapSourcesToProject, packageName, resolveLocalPath } from '../src/diagnostics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demoAppRoot = path.resolve(here, '../../../fixtures/demo-app');
// Real Lighthouse 13 report of fixtures/demo-app in slow mode.
const lhr = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/lhr-demo-slow.json'), 'utf8')) as Result;

describe('extractDiagnostics', () => {
  const diagnostics = extractDiagnostics(lhr);

  it('returns failing audits ranked by impact', () => {
    const ids = diagnostics.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['image-delivery-insight', 'unused-javascript', 'render-blocking-insight', 'bootup-time']));
    const impacts = diagnostics.findings.filter((f) => !f.devServerArtifact).map((f) => f.impact);
    expect(impacts).toEqual([...impacts].sort((a, b) => b - a));
    // A 5.7 MB hero image should outrank 150ms of render-blocking CSS.
    expect(ids.indexOf('image-delivery-insight')).toBeLessThan(ids.indexOf('render-blocking-insight'));
  });

  it('ranks header-driven findings last on localhost, flagged as dev-server artifacts', () => {
    const cache = diagnostics.findings.find((f) => f.id === 'cache-insight')!;
    expect(cache.devServerArtifact).toBe(true);
    expect(diagnostics.findings.at(-1)?.id).toBe('cache-insight');
    expect(diagnostics.findings[0]?.id).toBe('image-delivery-insight');
  });

  it('normalizes items with selectors, notes and source-mapped origins', () => {
    const image = diagnostics.findings.find((f) => f.id === 'image-delivery-insight')!;
    expect(image.items[0]).toMatchObject({ url: 'http://localhost:4321/hero-big.png', selector: 'body > div.layout > img.hero' });
    expect(image.items[0]!.notes?.some((n) => n.includes('larger than it needs to be'))).toBe(true);

    const unusedJs = diagnostics.findings.find((f) => f.id === 'unused-javascript')!;
    expect(unusedJs.savings.bytes).toBeGreaterThan(40_000);
    expect(unusedJs.items[0]!.sources?.[0]?.source).toContain('lodash/lodash.js');
  });

  it('extracts the LCP element, layout shift culprits and long tasks', () => {
    expect(diagnostics.lcpElement?.selector).toBe('body > div.layout > p');
    expect(diagnostics.lcpElement?.phases.map((p) => p.phase)).toContain('Element render delay');
    expect(diagnostics.layoutShifts[0]?.causes[0]).toContain('Unsized image element');
    expect(diagnostics.longTasks[0]).toMatchObject({ url: 'http://localhost:4321/main.js' });
    expect(diagnostics.longTasks[0]!.durationMs).toBeGreaterThan(1000);
  });

  it('attributes bundle bytes to source files and packages', () => {
    const lodash = diagnostics.sources.find((s) => s.package === 'lodash');
    expect(lodash?.bytes).toBeGreaterThan(70_000);
    expect(diagnostics.sources.some((s) => s.source.endsWith('src/main.ts'))).toBe(true);
  });

  it('maps source-map paths to files in the local project', () => {
    const mapped = mapSourcesToProject(extractDiagnostics(lhr), demoAppRoot);
    expect(mapped.sources.find((s) => s.source.endsWith('src/main.ts'))?.localPath).toBe('src/main.ts');
    // Dependencies are reported by package, not resolved into node_modules.
    expect(mapped.sources.find((s) => s.package === 'lodash')?.localPath).toBeUndefined();
  });
});

describe('extractDiagnostics edge cases', () => {
  it('keeps failing audits that carry no score instead of dropping them', () => {
    const copy = structuredClone(lhr);
    delete (copy.audits['bootup-time'] as { score?: number | null }).score;
    expect(extractDiagnostics(copy).findings.map((f) => f.id)).toContain('bootup-time');
  });

  it('skips audits Lighthouse could not score (null) and audits missing from the report', () => {
    const copy = structuredClone(lhr);
    copy.audits['bootup-time']!.score = null;
    delete (copy.audits as Record<string, unknown>)['unused-javascript'];
    const ids = extractDiagnostics(copy).findings.map((f) => f.id);
    expect(ids).not.toContain('bootup-time');
    expect(ids).not.toContain('unused-javascript');
  });

  it('stringifies primitive layout-shift causes and falls back for unusable ones', () => {
    const copy = structuredClone(lhr);
    const tables = (copy.audits['cls-culprits-insight']!.details as { items: { items: { subItems?: { items: Record<string, unknown>[] } }[] }[] }).items;
    const items = tables.flatMap((t) => t.items);
    const subItems = items.find((i) => i.subItems?.items.length)!.subItems!.items;
    subItems[0]!.cause = 404;
    subItems.push({ cause: { unexpected: true } });
    const causes = extractDiagnostics(copy).layoutShifts.flatMap((s) => s.causes);
    expect(causes.some((c) => c.startsWith('404'))).toBe(true);
    expect(causes.some((c) => c.startsWith('Unknown cause'))).toBe(true);
    expect(causes.some((c) => c.includes('[object Object]'))).toBe(false);
  });
});

describe('impactScore', () => {
  it('weights savings relative to each metric threshold', () => {
    // 250ms LCP (10% of 2.5s, weight 25) == 20ms TBT (10% of 200ms, weight 30) * 25/30
    expect(impactScore({ lcp: 250 })).toBe(2.5);
    expect(impactScore({ tbt: 20 })).toBe(3);
    expect(impactScore({ bytes: 200 * 1024 })).toBe(2);
    expect(impactScore({})).toBe(0);
  });
});

describe('packageName', () => {
  it('handles plain, scoped and pnpm-nested paths', () => {
    expect(packageName('node_modules/react-dom/cjs/x.js')).toBe('react-dom');
    expect(packageName('../node_modules/.pnpm/@tanstack+query@5/node_modules/@tanstack/query-core/build/x.js')).toBe('@tanstack/query-core');
    expect(packageName('src/app.ts')).toBeUndefined();
  });
});

describe('resolveLocalPath', () => {
  it('strips bundler prefixes and relative segments', () => {
    expect(resolveLocalPath('../../src/main.ts', demoAppRoot)).toBe('src/main.ts');
    expect(resolveLocalPath('webpack://demo/./src/products.ts', demoAppRoot)).toBe('src/products.ts');
    expect(resolveLocalPath('dist/build/src/analytics.ts?v=3', demoAppRoot)).toBe('src/analytics.ts');
  });

  it('does not guess from a bare filename deep in a path', () => {
    expect(resolveLocalPath('other/place/main.ts', demoAppRoot)).toBeUndefined();
  });
});

describe('third-party classification', () => {
  it('flags items whose origin Lighthouse lists as a non-first-party entity', () => {
    const urlItem = extractDiagnostics(lhr).findings.flatMap((f) => f.items).find((i) => i.url);
    expect(urlItem?.url).toBeDefined();
    const origin = new URL(urlItem!.url!).origin;
    const marked = extractDiagnostics({ ...lhr, entities: [{ name: 'Tracker', origins: [origin] }] });
    expect(marked.findings.flatMap((f) => f.items).filter((i) => i.url?.startsWith(origin)).every((i) => i.thirdParty)).toBe(true);
    const firstParty = extractDiagnostics({ ...lhr, entities: [{ name: 'Me', isFirstParty: true, origins: [origin] }] });
    expect(firstParty.findings.flatMap((f) => f.items).some((i) => i.thirdParty)).toBe(false);
  });
});
