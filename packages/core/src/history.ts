import crypto from 'node:crypto';
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
  // Pages that differ only by query string (/search?q=a vs ?q=b) are different pages.
  // Params are sorted so ?a=1&b=2 and ?b=2&a=1 (the same page) share one history.
  u.searchParams.sort();
  const query = u.search ? `_q${crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 8)}` : '';
  return `${slug}${query}__${preset}`;
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

/**
 * Decode a text file that may be UTF-8 (with or without BOM) or UTF-16. Windows PowerShell 5.1
 * writes UTF-16 LE when output is redirected with `>`, which would otherwise fail JSON.parse.
 */
function readText(file: string): string {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readResult(file: string): AuditResult {
  let parsed: Partial<AuditResult> & { pages?: { result?: AuditResult }[] };
  try {
    parsed = JSON.parse(readText(file)) as typeof parsed;
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  // `redline --json` prints a report ({ pages: [{ result }] }); accept it when it holds one page.
  if (Array.isArray(parsed.pages)) {
    const [only, ...rest] = parsed.pages;
    if (!only?.result || rest.length > 0) {
      throw new Error(`${file} is a report with ${parsed.pages.length} pages; use a single-page report or a saved result from .redline/history`);
    }
    parsed = only.result;
  }
  if (typeof parsed.url !== 'string' || !Array.isArray(parsed.metrics)) {
    throw new Error(`${file} is not a Redline audit result`);
  }
  // Results saved before diagnostics existed still compare fine on metrics.
  parsed.diagnostics ??= { findings: [], layoutShifts: [], longTasks: [], sources: [] };
  return parsed as AuditResult;
}
