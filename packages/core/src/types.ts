export type MetricId = 'lcp' | 'fcp' | 'cls' | 'tbt' | 'si' | 'ttfb';

export type Rating = 'good' | 'needs-improvement' | 'poor';

export type Preset = 'mobile' | 'desktop';

export interface Metric {
  id: MetricId;
  label: string;
  /** Median across runs. Milliseconds, except CLS which is unitless. */
  value: number;
  unit: 'ms' | 'unitless';
  rating: Rating;
  /** Raw value from each run, in run order. */
  samples: number[];
}

export interface AuditOptions {
  /** Number of Lighthouse runs; metrics are reported as the median. Default 1. */
  runs?: number;
  /** Device/network emulation profile. Default 'mobile'. */
  preset?: Preset;
  /** Called after each run completes. */
  onProgress?: (completedRuns: number, totalRuns: number) => void;
}

export interface AuditResult {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  preset: Preset;
  runs: number;
  /** Median Lighthouse performance score, 0-100. Null if Lighthouse could not score the page. */
  score: number | null;
  metrics: Metric[];
  lighthouseVersion: string;
}
