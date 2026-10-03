import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { AuditResult, RedlineReport } from '@redline/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { collectSources, explainReport } from '../src/explain.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-agent-'));
fs.mkdirSync(path.join(root, 'src'));
fs.writeFileSync(path.join(root, 'src/main.ts'), "import _ from 'lodash';\n");
fs.writeFileSync(path.join(root, 'src/big.ts'), 'x'.repeat(70 * 1024));
fs.writeFileSync(path.join(root, 'secret.env'), 'TOKEN=1');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

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

  it('returns nothing without a project root', () => {
    expect(collectSources(report(), undefined, 1000)).toEqual({ included: [], omitted: [] });
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
