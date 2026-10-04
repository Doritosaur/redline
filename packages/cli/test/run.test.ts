import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuditResult } from '@redline/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baselinePath, normalizeUrl, readBaseline, writeBaseline, writeOutput } from '../src/run.js';

describe('normalizeUrl', () => {
  it.each([
    ['localhost:3000', 'http://localhost:3000'],
    ['example.com/a?b=1', 'http://example.com/a?b=1'],
    ['https://example.com', 'https://example.com'],
    ['HTTP://example.com', 'HTTP://example.com'],
  ])('%s -> %s', (input, expected) => expect(normalizeUrl(input)).toBe(expected));
});

describe('baselines and output files', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-run-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = { url: 'http://localhost:3000/', finalUrl: 'http://localhost:3000/', fetchedAt: '2026-10-01T10:00:00.000Z', preset: 'mobile', runs: 1, score: 90, lighthouseVersion: '13.5.0', metrics: [], diagnostics: { findings: [], layoutShifts: [], longTasks: [], sources: [] } } as AuditResult;

  it('returns nothing when no baseline exists, and round-trips one once written', () => {
    expect(readBaseline(result.url, 'mobile', dir)).toBeUndefined();
    const file = writeBaseline(result, dir);
    expect(file).toBe(baselinePath(result.url, 'mobile', dir));
    expect(readBaseline(result.url, 'mobile', dir)).toMatchObject({ url: result.url, score: 90 });
    expect(readBaseline(result.url, 'desktop', dir)).toBeUndefined();
  });

  it('writeOutput creates missing parent directories', () => {
    const file = path.join(dir, 'a', 'b', 'report.md');
    writeOutput(file, '# hi');
    expect(fs.readFileSync(file, 'utf8')).toBe('# hi');
  });
});
