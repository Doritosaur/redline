import type { Browser, BrowserType } from 'playwright';
import type { BrowserName } from './config.js';
import { median } from './metrics.js';

export interface BrowserMetrics {
  /** null when the browser does not expose the metric (e.g. CLS outside Chromium). */
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  domContentLoaded: number | null;
  load: number | null;
}

export interface BrowserRun {
  browser: BrowserName;
  version?: string;
  /** Medians across runs. */
  metrics: BrowserMetrics;
  requests: number;
  transferBytes: number;
  /** Uncaught exceptions and console.error output; often the first sign of a compatibility bug. */
  errors: string[];
  failedRequests: string[];
  /** Set when the browser could not be launched or the page could not be measured. */
  error?: string;
}

export interface CrossBrowserOptions {
  browsers?: BrowserName[];
  runs?: number;
  /** Extra time after `load` for late LCP candidates and layout shifts. Default 2000ms. */
  settleMs?: number;
}

// Runs in the page before any of its scripts. Observers use `buffered: true` so early entries aren't missed,
// and unsupported entry types are recorded as null rather than 0.
const COLLECTOR = `(() => {
  const supported = (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes) || [];
  const state = window.__redline = {
    lcp: supported.includes('largest-contentful-paint') ? 0 : null,
    cls: supported.includes('layout-shift') ? 0 : null,
  };
  if (state.lcp !== null) new PerformanceObserver((list) => {
    for (const e of list.getEntries()) state.lcp = e.renderTime || e.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  if (state.cls !== null) new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) state.cls += e.value;
  }).observe({ type: 'layout-shift', buffered: true });
})();`;

interface PageSample {
  metrics: BrowserMetrics;
  requests: number;
  transferBytes: number;
}

/**
 * Load a page in Chromium, Firefox and WebKit and read each engine's own performance timings.
 * Unthrottled and on this machine, so numbers are for comparing engines against each other, not for
 * absolute Core Web Vitals (use the Lighthouse audit for those).
 */
export async function measureAcrossBrowsers(url: string, options: CrossBrowserOptions = {}): Promise<BrowserRun[]> {
  const playwright = await import('playwright');
  const names = options.browsers ?? ['chromium', 'firefox', 'webkit'];
  const runs = options.runs ?? 1;
  const out: BrowserRun[] = [];

  for (const name of names) {
    const run: BrowserRun = { browser: name, metrics: emptyMetrics(), requests: 0, transferBytes: 0, errors: [], failedRequests: [] };
    out.push(run);
    let browser: Browser | undefined;
    try {
      browser = await launch(playwright[name], name);
      run.version = browser.version();
      const samples: PageSample[] = [];
      for (let i = 0; i < runs; i++) {
        samples.push(await measureOnce(browser, url, options.settleMs ?? 2000, run));
      }
      run.metrics = medianMetrics(samples.map((s) => s.metrics));
      run.requests = Math.round(median(samples.map((s) => s.requests)));
      run.transferBytes = Math.round(median(samples.map((s) => s.transferBytes)));
      run.errors = [...new Set(run.errors)];
      run.failedRequests = [...new Set(run.failedRequests)];
    } catch (err) {
      run.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
    } finally {
      await browser?.close();
    }
  }
  return out;
}

async function launch(type: BrowserType, name: BrowserName): Promise<Browser> {
  try {
    return await type.launch();
  } catch (err) {
    const missing = err instanceof Error && /Executable doesn't exist/i.test(err.message);
    if (!missing) throw err;
    // Prefer an installed Chrome or Edge over making people download Playwright's Chromium.
    if (name === 'chromium') {
      for (const channel of ['chrome', 'msedge']) {
        try {
          return await type.launch({ channel });
        } catch {
          // try the next channel
        }
      }
    }
    throw new Error(`${name} is not installed. Run: npx playwright install ${name}`, { cause: err });
  }
}

async function measureOnce(browser: Browser, url: string, settleMs: number, run: BrowserRun): Promise<PageSample> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.on('pageerror', (e) => run.errors.push(`Uncaught: ${e.message}`));
    page.on('console', (m) => {
      // Chromium logs failed loads without the URL; those are captured with their URL via `response` below.
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) run.errors.push(`console.error: ${m.text()}`);
    });
    page.on('requestfailed', (r) => run.failedRequests.push(`${r.url()} (${r.failure()?.errorText ?? 'failed'})`));
    page.on('response', (r) => {
      if (r.status() >= 400 && !new URL(r.url()).pathname.endsWith('/favicon.ico')) {
        run.failedRequests.push(`${r.url()} (HTTP ${r.status()})`);
      }
    });
    await page.addInitScript(COLLECTOR);
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(settleMs);

    return await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const state = (window as unknown as { __redline: { lcp: number | null; cls: number | null } }).__redline;
      const positive = (n: number | undefined) => (n && n > 0 ? n : null);
      return {
        metrics: {
          ttfb: positive(nav?.responseStart),
          fcp: fcp ? fcp.startTime : null,
          // An observer that never fired (0) means unsupported in practice, not a 0ms LCP.
          lcp: state.lcp || null,
          cls: state.cls,
          domContentLoaded: positive(nav?.domContentLoadedEventEnd),
          load: positive(nav?.loadEventEnd),
        },
        requests: resources.length + 1,
        transferBytes: resources.reduce((sum, r) => sum + (r.transferSize || 0), nav?.transferSize ?? 0),
      };
    });
  } finally {
    await context.close();
  }
}

function emptyMetrics(): BrowserMetrics {
  return { ttfb: null, fcp: null, lcp: null, cls: null, domContentLoaded: null, load: null };
}

function medianMetrics(samples: BrowserMetrics[]): BrowserMetrics {
  const out = emptyMetrics();
  for (const key of Object.keys(out) as (keyof BrowserMetrics)[]) {
    const values = samples.map((s) => s[key]).filter((v): v is number => v !== null);
    out[key] = values.length ? median(values) : null;
  }
  return out;
}
