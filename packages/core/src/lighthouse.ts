import * as chromeLauncher from 'chrome-launcher';
import lighthouse, { desktopConfig, type Result } from 'lighthouse';
import { extractDiagnostics, mapSourcesToProject } from './diagnostics.js';
import { METRICS, median, rate } from './metrics.js';
import type { AuditOptions, AuditResult, Metric } from './types.js';

/**
 * Audit a URL (live or localhost) with Lighthouse in headless Chrome.
 * Runs `runs` times against one Chrome instance and reports per-metric medians.
 */
export async function audit(url: string, options: AuditOptions = {}): Promise<AuditResult> {
  const runs = options.runs ?? 1;
  const preset = options.preset ?? 'mobile';
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer, got ${runs}`);
  assertHttpUrl(url);
  if (!options.skipReachabilityCheck) await assertReachable(url);

  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-first-run', ...(options.chromeFlags ?? [])] });
  const reports: Result[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const result = await lighthouse(
        url,
        { port: chrome.port, logLevel: 'error', onlyCategories: ['performance'] },
        preset === 'desktop' ? desktopConfig : undefined,
      );
      if (!result) throw new Error(`Lighthouse returned no result for ${url}`);
      if (result.lhr.runtimeError) {
        throw new Error(`Lighthouse could not load ${url}: ${result.lhr.runtimeError.message}`);
      }
      reports.push(result.lhr);
      options.onProgress?.(i + 1, runs);
    }
  } finally {
    chrome.kill();
  }

  const result = summarize(url, preset, reports);
  if (options.projectRoot) mapSourcesToProject(result.diagnostics, options.projectRoot);
  return result;
}

export function summarize(url: string, preset: AuditResult['preset'], reports: readonly Result[]): AuditResult {
  const first = reports[0];
  if (!first) throw new Error('summarize() needs at least one Lighthouse report');

  const metrics: Metric[] = [];
  for (const def of METRICS) {
    const samples = reports
      .map((r) => r.audits[def.audit]?.numericValue)
      .filter((v): v is number => typeof v === 'number');
    // Some metrics (e.g. TTFB on a failed document request) can be missing; skip rather than invent a value.
    if (samples.length === 0) continue;
    const value = median(samples);
    metrics.push({ id: def.id, label: def.label, value, unit: def.unit, rating: rate(def.id, value), samples });
  }

  const scores = reports
    .map((r) => r.categories.performance?.score)
    .filter((s): s is number => typeof s === 'number');

  return {
    url,
    finalUrl: first.finalDisplayedUrl,
    fetchedAt: first.fetchTime,
    preset,
    runs: reports.length,
    score: scores.length > 0 ? Math.round(median(scores) * 100) : null,
    metrics,
    diagnostics: extractDiagnostics(representativeReport(reports, metrics)),
    lighthouseVersion: first.lighthouseVersion,
  };
}

/** The run whose LCP is closest to the median, so diagnostics describe a typical run rather than an outlier. */
function representativeReport(reports: readonly Result[], metrics: readonly Metric[]): Result {
  const lcp = metrics.find((m) => m.id === 'lcp');
  if (!lcp || lcp.samples.length !== reports.length) return reports[0]!;
  let best = 0;
  lcp.samples.forEach((sample, i) => {
    if (Math.abs(sample - lcp.value) < Math.abs(lcp.samples[best]! - lcp.value)) best = i;
  });
  return reports[best]!;
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs can be audited, got ${parsed.protocol}`);
  }
}

/** Fail fast with a clear message instead of Lighthouse's generic "interstitial" error. */
async function assertReachable(url: string): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
    await res.body?.cancel();
  } catch (err) {
    const { hostname } = new URL(url);
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    const hint = isLocal ? ' Is your dev server running?' : '';
    // Node wraps connection failures in `cause`; on localhost it's an AggregateError (IPv4 + IPv6) with an empty message.
    const raw = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
    const detail = raw?.code || raw?.message || (err instanceof Error ? err.message : '');
    const cause = detail ? ` (${detail})` : '';
    throw new Error(`Nothing is responding at ${url}.${hint}${cause}`);
  }
}
