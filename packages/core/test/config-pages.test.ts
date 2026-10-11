import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromeFlagsFromEnv, lighthouseLogLevel } from '../src/chrome.js';
import { loadConfig } from '../src/config.js';
import { groupByTemplate, parseSitemapLocs, resolvePages, urlTemplate } from '../src/pages.js';

describe('loadConfig', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-config-'));
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns undefined when there is no config', async () => {
    expect(await loadConfig(dir)).toBeUndefined();
  });

  it('loads a TypeScript config and resolves paths against its directory', async () => {
    const sub = path.join(dir, 'ts');
    fs.mkdirSync(sub);
    fs.writeFileSync(
      path.join(sub, 'redline.config.ts'),
      `const budgets: { lcp: number } = { lcp: 2500 };\nexport default { baseUrl: 'http://localhost:3000', pages: ['/'], budgets, projectRoot: 'app' };\n`,
    );
    const loaded = await loadConfig(sub);
    expect(loaded?.config.budgets).toEqual({ lcp: 2500 });
    expect(loaded?.projectRoot).toBe(path.join(sub, 'app'));
    expect(loaded?.historyDir).toBe(path.join(sub, '.redline'));
  });

  it('reports invalid fields and typos clearly', async () => {
    const sub = path.join(dir, 'bad');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'redline.config.json'), JSON.stringify({ budgets: { lpc: 2500 }, runs: 0 }));
    const error = await loadConfig(sub).then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(error).toMatch(/budgets: Unrecognized key.*lpc/);
    expect(error).toMatch(/runs: Too small/);
  });
});

describe('urlTemplate', () => {
  it('collapses ids, uuids, hashes and id-suffixed slugs', () => {
    expect(urlTemplate('https://x.com/products/123')).toBe('/products/:id');
    expect(urlTemplate('https://x.com/u/3f2b8c1e-1d2a-4b5c-9e8f-0a1b2c3d4e5f/settings')).toBe('/u/:id/settings');
    expect(urlTemplate('https://x.com/p/blue-chair-48213')).toBe('/p/:slug');
    expect(urlTemplate('https://x.com/about')).toBe('/about');
    expect(urlTemplate('https://x.com/')).toBe('/');
  });

  it('groups pages that share a template', () => {
    const groups = groupByTemplate(['https://x.com/products/1', 'https://x.com/products/2', 'https://x.com/about']);
    expect([...groups.keys()]).toEqual(['/products/:id', '/about']);
    expect(groups.get('/products/:id')).toHaveLength(2);
  });
});

describe('sitemaps', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const loc = (p: string) => `<url><loc>${base}${p}</loc></url>`;
      if (req.url === '/sitemap-index.xml') {
        res.end(`<sitemapindex><sitemap><loc>${base}/a.xml</loc></sitemap><sitemap><loc>${base}/b.xml</loc></sitemap></sitemapindex>`);
      } else if (req.url === '/a.xml') {
        res.end(`<urlset>${loc('/')}${loc('/products/1')}${loc('/products/2')}</urlset>`);
      } else if (req.url === '/b.xml') {
        res.end(`<urlset>${loc('/products/3')}${loc('/about?a=1&amp;b=2')}</urlset>`);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('parses <loc> entries and decodes XML entities', () => {
    expect(parseSitemapLocs('<loc> https://x.com/?a=1&amp;b=2 </loc>')).toEqual(['https://x.com/?a=1&b=2']);
  });

  it('follows sitemap indexes, merges explicit pages, and samples per template', async () => {
    const pages = await resolvePages({ baseUrl: base, pages: ['/'], sitemap: '/sitemap-index.xml', perTemplate: 1 });
    expect(pages).toEqual([`${base}/`, `${base}/products/1`, `${base}/about?a=1&b=2`]);
  });

  it('rejects relative pages without a baseUrl', async () => {
    await expect(resolvePages({ pages: ['/x'] })).rejects.toThrow(/baseUrl/);
  });
});

describe('chromeFlagsFromEnv', () => {
  it('splits REDLINE_CHROME_FLAGS on whitespace and ignores blanks', () => {
    expect(chromeFlagsFromEnv({ REDLINE_CHROME_FLAGS: ' --no-sandbox   --disable-dev-shm-usage ' })).toEqual(['--no-sandbox', '--disable-dev-shm-usage']);
    expect(chromeFlagsFromEnv({})).toEqual([]);
  });
});

describe('lighthouseLogLevel', () => {
  it('is silent by default so third-party source-map warnings do not leak, and verbose with REDLINE_DEBUG', () => {
    expect(lighthouseLogLevel({})).toBe('silent');
    expect(lighthouseLogLevel({ REDLINE_DEBUG: '1' })).toBe('info');
  });
});
