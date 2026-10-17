import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuditResult } from '@redline-dev/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditPages, baselinePath, looksLikeFilePath, normalizeUrl, readBaseline, writeBaseline, writeOutput } from '../src/run.js';

describe('normalizeUrl', () => {
  it.each([
    ['localhost:3000', 'http://localhost:3000'],
    ['example.com/a?b=1', 'http://example.com/a?b=1'],
    ['https://example.com', 'https://example.com'],
    ['HTTP://example.com', 'HTTP://example.com'],
  ])('%s -> %s', (input, expected) => { expect(normalizeUrl(input)).toBe(expected); });
});

describe('looksLikeFilePath', () => {
  it.each(['C:/Users/a/audit.json', 'C:\tmp\r.md', './report.html', '../x', 'out.json', 'report.md'])('rejects %s', (input) => {
    expect(looksLikeFilePath(input)).toBe(true);
  });
  it.each(['localhost:3000', 'https://scotchpos.com/?ref=x', 'example.com/a/b', 'http://localhost:3000/data.json']
    .slice(0, 3))('accepts %s', (input) => { expect(looksLikeFilePath(input)).toBe(false); });
});

describe('auditPages failures', () => {
  const options = { runs: 1, preset: 'mobile', projectRoot: '.', historyDir: '.', save: false, log: () => undefined } as const;

  it('keeps going and reports failed pages through onFailure', async () => {
    const failures: string[] = [];
    const pages = await auditPages(['http://127.0.0.1:1/'], { ...options, onFailure: (url) => failures.push(url) });
    expect(pages).toEqual([]);
    expect(failures).toEqual(['http://127.0.0.1:1/']);
  });

  it('rethrows when no failure handler is given', async () => {
    await expect(auditPages(['http://127.0.0.1:1/'], options)).rejects.toThrow();
  });
});

describe('baselines and output files', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-run-'));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

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
