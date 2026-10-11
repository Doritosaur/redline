import type { Preset, Rating } from './types.js';

export type FieldMetricId = 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb';

export interface FieldMetric {
  id: FieldMetricId;
  label: string;
  /** 75th percentile across real Chrome users (ms, CLS unitless). */
  p75: number;
  rating: Rating;
  /** Share of page loads that were good / needs improvement / poor (0-1). */
  distribution: { good: number; needsImprovement: number; poor: number };
}

export interface FieldData {
  source: 'chrome-ux-report';
  /** "url" when the page itself has enough traffic, otherwise "origin" (whole site). */
  scope: 'url' | 'origin';
  key: string;
  formFactor: 'PHONE' | 'DESKTOP';
  /** e.g. "2026-09-05 to 2026-10-02" (a rolling 28-day window). */
  collectionPeriod?: string;
  metrics: FieldMetric[];
}

export interface FieldDataOptions {
  apiKey: string;
  preset?: Preset;
  fetch?: typeof fetch;
}

const ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

// CrUX metric keys; TTFB has been published under both names.
const FIELD_METRICS: { id: FieldMetricId; label: string; keys: string[]; thresholds: [number, number] }[] = [
  { id: 'lcp', label: 'Largest Contentful Paint', keys: ['largest_contentful_paint'], thresholds: [2500, 4000] },
  { id: 'inp', label: 'Interaction to Next Paint', keys: ['interaction_to_next_paint'], thresholds: [200, 500] },
  { id: 'cls', label: 'Cumulative Layout Shift', keys: ['cumulative_layout_shift'], thresholds: [0.1, 0.25] },
  { id: 'fcp', label: 'First Contentful Paint', keys: ['first_contentful_paint'], thresholds: [1800, 3000] },
  { id: 'ttfb', label: 'Time to First Byte', keys: ['time_to_first_byte', 'experimental_time_to_first_byte'], thresholds: [800, 1800] },
];

/**
 * Real-user Core Web Vitals from the Chrome UX Report. Tries the exact URL first, then falls back to the origin.
 * Returns undefined when Google has no data (low-traffic or non-public sites, including localhost).
 */
export async function fetchFieldData(url: string, options: FieldDataOptions): Promise<FieldData | undefined> {
  const doFetch = options.fetch ?? fetch;
  const formFactor = options.preset === 'desktop' ? 'DESKTOP' : 'PHONE';
  const { origin, hostname } = new URL(url);
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return undefined;

  for (const scope of ['url', 'origin'] as const) {
    const key = scope === 'url' ? url : origin;
    const res = await doFetch(`${ENDPOINT}?key=${encodeURIComponent(options.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [scope]: key, formFactor }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) continue; // not enough traffic at this scope
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Chrome UX Report API returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return parseRecord(scope, key, formFactor, await res.json());
  }
  return undefined;
}

interface CruxMetric {
  histogram?: { start: number | string; end?: number | string; density?: number }[];
  percentiles?: { p75?: number | string };
}
interface CruxDate {
  year: number;
  month: number;
  day: number;
}

export function parseRecord(scope: FieldData['scope'], key: string, formFactor: FieldData['formFactor'], body: unknown): FieldData {
  const record = (body as { record?: { metrics?: Record<string, CruxMetric>; collectionPeriod?: { firstDate: CruxDate; lastDate: CruxDate } } })
    .record;
  const metrics: FieldMetric[] = [];
  for (const def of FIELD_METRICS) {
    const raw = def.keys.map((k) => record?.metrics?.[k]).find(Boolean);
    const p75 = Number(raw?.percentiles?.p75);
    if (!raw || !Number.isFinite(p75)) continue;
    const [good = 0, needsImprovement = 0, poor = 0] = (raw.histogram ?? []).map((b) => b.density ?? 0);
    const [goodMax, niMax] = def.thresholds;
    metrics.push({
      id: def.id,
      label: def.label,
      p75,
      rating: p75 <= goodMax ? 'good' : p75 <= niMax ? 'needs-improvement' : 'poor',
      distribution: { good, needsImprovement, poor },
    });
  }
  const period = record?.collectionPeriod;
  const fmt = (d: CruxDate) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  return {
    source: 'chrome-ux-report',
    scope,
    key,
    formFactor,
    ...(period ? { collectionPeriod: `${fmt(period.firstDate)} to ${fmt(period.lastDate)}` } : {}),
    metrics,
  };
}
