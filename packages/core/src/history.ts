import fs from 'node:fs';
import path from 'node:path';
import type { AuditResult, Preset } from './types.js';

export const DEFAULT_HISTORY_DIR = '.redline';

/**
 * Run history lives on disk as `<dir>/history/<page-key>/<timestamp>.json`, one file per audit,
 * so it can be inspected, diffed, cached in CI, or deleted by hand.
 */
export function historyKey(url: string, preset: Preset): string {
  const u = new URL(url);
  const pathPart = `${u.host}${u.pathname}`.replace(/\/+$/, '') || u.host;
  const slug = pathPart.replace(/[^a-z0-9.-]+/gi, '_').replace(/^_+|_+$/g, '');
  return `${slug}__${preset}`;
}

export function saveRun(result: AuditResult, dir = DEFAULT_HISTORY_DIR): string {
  const folder = path.join(dir, 'history', historyKey(result.url, result.preset));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${result.fetchedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

/** Most recent saved run for this URL and preset, or undefined if there is none. */
export function loadLatestRun(url: string, preset: Preset, dir = DEFAULT_HISTORY_DIR): AuditResult | undefined {
  return listRuns(url, preset, dir).at(-1);
}

/** Saved runs for this URL and preset, oldest first. */
export function listRuns(url: string, preset: Preset, dir = DEFAULT_HISTORY_DIR): AuditResult[] {
  const folder = path.join(dir, 'history', historyKey(url, preset));
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readResult(path.join(folder, f)));
}

export function readResult(file: string): AuditResult {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AuditResult>;
  if (typeof parsed.url !== 'string' || !Array.isArray(parsed.metrics)) {
    throw new Error(`${file} is not a Redline audit result`);
  }
  // Results saved before diagnostics existed still compare fine on metrics.
  parsed.diagnostics ??= { findings: [], layoutShifts: [], longTasks: [], sources: [] };
  return parsed as AuditResult;
}
