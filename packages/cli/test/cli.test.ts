import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditResult } from '@redline/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const result = (lcp: number): AuditResult => ({
  url: 'http://localhost:3000/',
  finalUrl: 'http://localhost:3000/',
  fetchedAt: '2026-10-01T10:00:00.000Z',
  preset: 'mobile',
  runs: 3,
  score: 80,
  lighthouseVersion: '13.5.0',
  metrics: [{ id: 'lcp', label: 'Largest Contentful Paint', value: lcp, unit: 'ms', rating: 'needs-improvement', samples: [lcp, lcp, lcp] }],
  diagnostics: { findings: [], layoutShifts: [], longTasks: [], sources: [] },
});

describe('redline CLI', () => {
  let cwd: string;
  beforeAll(() => {
    if (!fs.existsSync(bin)) throw new Error('packages/cli/dist is missing. Run `pnpm build` before the tests.');
  });
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-cli-'));
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string | undefined> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [bin, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CRUX_API_KEY: undefined, ...env } }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });

  it('prints help and the version, exit 0', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    for (const command of ['compare', 'browsers', 'compat', 'flow', 'field', 'explain', 'ci', 'init']) expect(help.stdout).toContain(`redline ${command}`);
    for (const flag of ['--runs', '--preset', '--baseline', '--no-save', '--json', '--md', '--html', '--update-baseline']) expect(help.stdout).toContain(flag);

    const version = await run(['--version']);
    expect(version).toMatchObject({ code: 0 });
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 2 with a hint on bad usage', async () => {
    for (const args of [['--nope'], ['--preset', 'tablet', 'localhost:3000'], ['--runs', '0', 'localhost:3000'], ['compare', 'only-one.json'], ['ci'], ['flow']]) {
      const res = await run(args);
      expect(res.code, args.join(' ')).toBe(2);
      expect(res.stderr).toContain('redline --help');
    }
  });

  it('refuses --field and field without CRUX_API_KEY', async () => {
    expect((await run(['field', 'https://example.com'])).code).toBe(2);
    expect((await run(['--field', 'https://example.com'])).code).toBe(2);
  });

  it('init writes a config once and refuses to overwrite it', async () => {
    const first = await run(['init']);
    expect(first.code).toBe(0);
    expect(fs.readFileSync(path.join(cwd, 'redline.config.ts'), 'utf8')).toContain('budgets');
    const second = await run(['init']);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain('already exists');
  });

  it('compares two saved results and reports the change', async () => {
    fs.writeFileSync(path.join(cwd, 'a.json'), JSON.stringify(result(4000)));
    fs.writeFileSync(path.join(cwd, 'b.json'), JSON.stringify(result(2400)));
    const res = await run(['compare', 'a.json', 'b.json']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/LCP|Largest Contentful Paint/);
  });
});
