import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as chromeLauncher from 'chrome-launcher';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCompat, runFlow } from '../src/index.js';

describe('checkCompat', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-compat-'));
    fs.writeFileSync(path.join(dir, 'app.js'), "fetch('/api').then((r) => r.json());\n");
    fs.writeFileSync(path.join(dir, 'styles.css'), '.grid { display: grid; gap: 1rem; }\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), "fetch('/ignored');\n");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('flags JS and CSS the targets cannot run, with locations, and skips node_modules', { timeout: 60_000 }, async () => {
    const report = await checkCompat(dir, { browsers: ['ie 11'] });
    expect(report.targets).toEqual(['ie 11']);
    expect(report.targetsSource).toBe('option');
    expect(report.filesScanned).toBe(2);
    const files = report.issues.map((i) => path.basename(i.file));
    expect(files).toContain('app.js');
    expect(files).toContain('styles.css');
    expect(report.issues.some((i) => i.file.includes('node_modules'))).toBe(false);
    // Regression: a root outside the cwd used to skip every JS file with "No matching configuration found".
    expect(report.skipped).toEqual([]);
    expect(report.issues.find((i) => i.file === 'app.js')).toMatchObject({ kind: 'js', line: 1, feature: 'fetch' });
  });

  it('reports nothing for modern targets', { timeout: 60_000 }, async () => {
    const report = await checkCompat(dir, { browsers: ['chrome 130'] });
    expect(report.issues).toEqual([]);
  });
});

const hasChrome = chromeLauncher.Launcher.getFirstInstallation() !== undefined;

describe.skipIf(!hasChrome)('runFlow in Chrome', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    server = http.createServer((_, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Flow</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<button id="slow">Slow</button><div id="out"></div>
<script>document.getElementById('slow').addEventListener('click', () => {
  const end = performance.now() + 400; while (performance.now() < end) {}
  document.getElementById('out').textContent = 'done';
});</script></body></html>`),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  it('measures a slow click as a poor INP, dominated by processing time', { timeout: 120_000 }, async () => {
    const flow = await runFlow(
      { name: 'Slow click', url: '/', steps: [{ click: '#slow' }, { wait: 300 }] },
      { baseUrl: base, chromeFlags: ['--no-sandbox'] },
    );
    expect(flow.steps).toHaveLength(2);
    expect(flow.navigation.score).not.toBeNull();
    expect(flow.interactions.inp).toBeGreaterThan(200);
    expect(flow.interactions.inpRating).not.toBe('good');
    const processing = flow.interactions.inpBreakdown.find((p) => p.phase === 'Processing duration');
    expect(processing?.ms).toBeGreaterThan(300);
  });
});
