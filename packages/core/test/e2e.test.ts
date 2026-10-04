import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as chromeLauncher from 'chrome-launcher';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../src/index.js';

// Needs a real Chrome. Skipped where none is installed, unless REDLINE_E2E=1 (set in CI) demands it.
const hasChrome = chromeLauncher.Launcher.getFirstInstallation() !== undefined;
if (process.env.REDLINE_E2E === '1' && !hasChrome) throw new Error('REDLINE_E2E=1 but no Chrome installation was found.');

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><script src="/blocking.js"></script></head>
<body><h1 id="hero">Redline fixture</h1><p>Hello.</p></body></html>`;

describe.skipIf(!hasChrome)('audit() against a real page in Chrome', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/blocking.js') {
        // A render-blocking script with a delay, so Lighthouse has something to report.
        setTimeout(() => res.writeHead(200, { 'content-type': 'text/javascript' }).end('window.__ready = true;'), 300);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => server?.close());

  it('returns a score, Core Web Vitals and diagnostics', { timeout: 120_000 }, async () => {
    const progress: number[] = [];
    const result = await audit(base, { runs: 1, chromeFlags: ['--no-sandbox'], onProgress: (done) => progress.push(done) });

    expect(progress).toEqual([1]);
    expect(result.url).toBe(base);
    expect(result.score).toBeGreaterThan(0);
    const ids = result.metrics.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['fcp', 'lcp']));
    for (const metric of result.metrics) expect(Number.isFinite(metric.value)).toBe(true);
    expect(result.diagnostics.findings).toBeInstanceOf(Array);
  });

  it('can be aborted, killing Chrome and rejecting with the abort reason', { timeout: 60_000 }, async () => {
    const controller = new AbortController();
    const pending = audit(base, { chromeFlags: ['--no-sandbox'], signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop')), 1500);
    await expect(pending).rejects.toThrow('stop');
  });
});
