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
  /** Local project directory; when set, source-mapped files are resolved to paths inside it. */
  projectRoot?: string;
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
  /** Diagnostics from the run closest to the median LCP. */
  diagnostics: Diagnostics;
  lighthouseVersion: string;
}

/** Estimated improvement if a finding is fixed. Times in ms, CLS unitless. */
export interface MetricSavings {
  lcp?: number;
  fcp?: number;
  tbt?: number;
  cls?: number;
  inp?: number;
  bytes?: number;
}

export interface FindingItem {
  url?: string;
  selector?: string;
  snippet?: string;
  label?: string;
  totalBytes?: number;
  wastedBytes?: number;
  wastedMs?: number;
  duration?: number;
  /** Human-readable reasons, e.g. "Unsized image element". */
  notes?: string[];
  /** Source-mapped origins of the bytes in this item. */
  sources?: Array<{ source: string; bytes?: number; wastedBytes?: number; localPath?: string }>;
}

export interface Finding {
  /** Lighthouse audit id, e.g. `unused-javascript`. */
  id: string;
  title: string;
  description: string;
  displayValue?: string;
  savings: MetricSavings;
  /** Relative priority; higher means fixing it should move the score more. */
  impact: number;
  items: FindingItem[];
}

export interface LcpElement {
  selector: string;
  snippet: string;
  label?: string;
  /** e.g. Time to first byte, Resource load delay, Element render delay. */
  phases: Array<{ phase: string; ms: number }>;
}

export interface LayoutShift {
  selector: string;
  snippet: string;
  score: number;
  causes: string[];
}

export interface LongTask {
  url: string;
  startMs: number;
  durationMs: number;
}

export interface SourceAttribution {
  /** Bundle URL the code ships in. */
  script: string;
  /** Path from the source map. */
  source: string;
  /** npm package, when the source lives in node_modules. */
  package?: string;
  /** Path relative to the project root, when it could be resolved locally. */
  localPath?: string;
  bytes: number;
  unusedBytes: number;
}

export interface Diagnostics {
  /** Failing audits, highest impact first. */
  findings: Finding[];
  lcpElement?: LcpElement;
  layoutShifts: LayoutShift[];
  longTasks: LongTask[];
  /** Per-source-file JavaScript cost, largest first. Empty when no source maps are available. */
  sources: SourceAttribution[];
}
