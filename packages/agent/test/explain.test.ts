import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { AuditResult, RedlineReport } from '@redline-dev/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { collectSources, isInside, explainReport } from '../src/explain.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-agent-'));
fs.mkdirSync(path.join(root, 'src'));
fs.writeFileSync(path.join(root, 'src/main.ts'), "import _ from 'lodash';\n");
fs.writeFileSync(path.join(root, 'src/big.ts'), 'x'.repeat(70 * 1024));
fs.writeFileSync(path.join(root, 'secret.env'), 'TOKEN=1');
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

function report(): RedlineReport {
  const result: AuditResult = {
    url: 'http://localhost:3000/',
    finalUrl: 'http://localhost:3000/',
    fetchedAt: '2026-10-03T10:00:00.000Z',
    preset: 'mobile',
    runs: 1,
    score: 40,
    lighthouseVersion: '13.5.0',
    metrics: [],
    diagnostics: {
      findings: [
        {
          id: 'unused-javascript',
          title: 'Reduce unused JavaScript',
          description: '',
          savings: { lcp: 300, bytes: 50_000 },
          impact: 3.5,
          items: [{ url: 'http://localhost:3000/main.js', sources: [{ source: '../src/main.ts', localPath: 'src/main.ts' }] }],
        },
      ],
      layoutShifts: [],
      longTasks: [],
      sources: [
        { script: 'main.js', source: '../src/big.ts', localPath: 'src/big.ts', bytes: 70_000, unusedBytes: 0 },
        // A hostile or broken source map must not make Redline read outside the project.
        { script: 'main.js', source: '../../secret.env', localPath: '../secret.env', bytes: 10, unusedBytes: 10 },
      ],
    },
  };
  return { generatedAt: '2026-10-03T10:00:00.000Z', pages: [{ result, violations: [] }] };
}

function fakeClient(message: Partial<Anthropic.Beta.BetaMessage>) {
  const stream = vi.fn(() => ({
    on: vi.fn(),
    finalMessage: async () => ({ model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 20 }, stop_details: null, ...message }),
  }));
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, stream };
}

describe('collectSources', () => {
  it('includes referenced files, lists oversized ones as omitted, and never escapes the project', () => {
    const { included, omitted } = collectSources(report(), root, 200 * 1024);
    expect(included.map((f) => f.path)).toEqual(['src/main.ts']);
    expect(omitted).toEqual(['src/big.ts']);
  });

  it('does not follow symlinks that point outside the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'SECRET');
    const link = path.join(root, 'src/linked.ts');
    try {
      fs.symlinkSync(path.join(outside, 'secret.ts'), link);
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return; // symlinks need privileges on some Windows setups
    }
    try {
      const r = report();
      r.pages[0]!.result.diagnostics.sources.push({ localPath: 'src/linked.ts', bytes: 10, unusedBytes: 5 } as never);
      expect(collectSources(r, root, 200 * 1024).included.map((f) => f.path)).not.toContain('src/linked.ts');
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('lists every referenced file as omitted when the project root cannot be resolved', () => {
    const { included, omitted } = collectSources(report(), path.join(root, 'does-not-exist'), 200 * 1024);
    expect(included).toEqual([]);
    expect(omitted).toContain('src/main.ts');
  });

  it('returns nothing without a project root', () => {
    expect(collectSources(report(), undefined, 1000)).toEqual({ included: [], omitted: [] });
  });
});

describe('isInside', () => {
  const fsRoot = path.parse(process.cwd()).root;

  it('accepts descendants, including when the root is a filesystem root', () => {
    expect(isInside(root, path.join(root, 'src', 'main.ts'))).toBe(true);
    expect(isInside(fsRoot, path.join(fsRoot, 'etc', 'x'))).toBe(true);
  });

  it('rejects the root itself, siblings that share a prefix, and parents', () => {
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, `${root}-evil${path.sep}x`)).toBe(false);
    expect(isInside(root, path.dirname(root))).toBe(false);
  });
});

describe('explainReport', () => {
  it('sends the report and sources to Claude with fallbacks enabled', async () => {
    const { client, stream } = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: '1. Import only `sortBy`.', citations: null }] });
    const result = await explainReport(report(), { client, projectRoot: root });

    const params = (stream.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'], output_config: { effort: 'high' } });
    const prompt = JSON.stringify(params.messages);
    expect(prompt).toContain('Reduce unused JavaScript');
    expect(prompt).toContain('<file path=\\"src/main.ts\\">');
    expect(prompt).toContain('not included because of size limits: src/big.ts');
    expect(prompt).not.toContain('TOKEN=1');
    expect(result).toMatchObject({ markdown: '1. Import only `sortBy`.', includedFiles: ['src/main.ts'], omittedFiles: ['src/big.ts'] });
  });

  it('turns a refusal into a clear error instead of empty output', async () => {
    const stopDetails = { type: 'refusal', category: 'cyber', explanation: null } as unknown as Anthropic.Beta.BetaRefusalStopDetails;
    const { client } = fakeClient({ stop_reason: 'refusal', content: [], stop_details: stopDetails });
    await expect(explainReport(report(), { client })).rejects.toThrow(/declined.*cyber/);
  });
});
