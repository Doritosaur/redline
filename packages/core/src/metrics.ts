import type { MetricId, Rating } from './types.js';

interface MetricDefinition {
  id: MetricId;
  label: string;
  /** Lighthouse audit id that carries this metric's numericValue. */
  audit: string;
  unit: 'ms' | 'unitless';
  /** Upper bound for "good" and for "needs improvement"; anything above is "poor". */
  thresholds: [good: number, needsImprovement: number];
}

// Thresholds follow web.dev / Lighthouse guidance.
export const METRICS: readonly MetricDefinition[] = [
  { id: 'lcp', label: 'Largest Contentful Paint', audit: 'largest-contentful-paint', unit: 'ms', thresholds: [2500, 4000] },
  { id: 'fcp', label: 'First Contentful Paint', audit: 'first-contentful-paint', unit: 'ms', thresholds: [1800, 3000] },
  { id: 'cls', label: 'Cumulative Layout Shift', audit: 'cumulative-layout-shift', unit: 'unitless', thresholds: [0.1, 0.25] },
  { id: 'tbt', label: 'Total Blocking Time', audit: 'total-blocking-time', unit: 'ms', thresholds: [200, 600] },
  { id: 'si', label: 'Speed Index', audit: 'speed-index', unit: 'ms', thresholds: [3400, 5800] },
  { id: 'ttfb', label: 'Time to First Byte', audit: 'server-response-time', unit: 'ms', thresholds: [800, 1800] },
];

export function rate(id: MetricId, value: number): Rating {
  const def = METRICS.find((m) => m.id === id);
  if (!def) throw new Error(`Unknown metric: ${id}`);
  const [good, needsImprovement] = def.thresholds;
  if (value <= good) return 'good';
  if (value <= needsImprovement) return 'needs-improvement';
  return 'poor';
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median() of an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
