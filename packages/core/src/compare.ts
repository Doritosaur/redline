import { METRICS, rate } from './metrics.js';
import type { AuditResult, MetricId, Rating } from './types.js';

export type Verdict = 'improved' | 'regressed' | 'unchanged';

export interface MetricDelta {
  id: MetricId;
  label: string;
  unit: 'ms' | 'unitless';
  before: number;
  after: number;
  delta: number;
  /** Relative change; null when `before` is 0. */
  deltaPct: number | null;
  ratingBefore: Rating;
  ratingAfter: Rating;
  verdict: Verdict;
}

export interface Comparison {
  url: string;
  before: { fetchedAt: string; runs: number; score: number | null };
  after: { fetchedAt: string; runs: number; score: number | null };
  scoreDelta: number | null;
  scoreVerdict: Verdict;
  metrics: MetricDelta[];
  regressions: MetricId[];
  improvements: MetricId[];
  /** Finding ids failing now but not before, and vice versa. */
  newFindings: string[];
  resolvedFindings: string[];
  /**
   * True when either side is a single run. Lab metrics routinely vary 10%+ between runs,
   * so single-run comparisons can flag noise as change.
   */
  lowConfidence: boolean;
}

/**
 * Minimum change treated as real rather than run-to-run noise: the larger of an absolute floor and a
 * fraction of the baseline. Tuned so typical Lighthouse variance on a stable page reads as "unchanged".
 */
export const NOISE_THRESHOLDS: Record<MetricId, { abs: number; rel: number }> = {
  lcp: { abs: 100, rel: 0.1 },
  fcp: { abs: 100, rel: 0.1 },
  si: { abs: 150, rel: 0.1 },
  tbt: { abs: 50, rel: 0.2 },
  ttfb: { abs: 50, rel: 0.15 },
  cls: { abs: 0.02, rel: 0 },
};
const SCORE_NOISE_POINTS = 3;

export function compareResults(before: AuditResult, after: AuditResult): Comparison {
  const metrics: MetricDelta[] = [];
  for (const def of METRICS) {
    const b = before.metrics.find((m) => m.id === def.id);
    const a = after.metrics.find((m) => m.id === def.id);
    if (!b || !a) continue;
    const delta = a.value - b.value;
    const { abs, rel } = NOISE_THRESHOLDS[def.id];
    const significant = Math.abs(delta) >= Math.max(abs, rel * b.value);
    metrics.push({
      id: def.id,
      label: def.label,
      unit: def.unit,
      before: b.value,
      after: a.value,
      delta,
      deltaPct: b.value === 0 ? null : delta / b.value,
      ratingBefore: rate(def.id, b.value),
      ratingAfter: rate(def.id, a.value),
      // Every tracked metric is lower-is-better.
      verdict: !significant ? 'unchanged' : delta > 0 ? 'regressed' : 'improved',
    });
  }

  const scoreDelta = before.score !== null && after.score !== null ? after.score - before.score : null;
  const failing = (r: AuditResult) => new Set(r.diagnostics.findings.map((f) => f.id));
  const beforeFindings = failing(before);
  const afterFindings = failing(after);

  return {
    url: after.url,
    before: { fetchedAt: before.fetchedAt, runs: before.runs, score: before.score },
    after: { fetchedAt: after.fetchedAt, runs: after.runs, score: after.score },
    scoreDelta,
    scoreVerdict:
      scoreDelta === null || Math.abs(scoreDelta) < SCORE_NOISE_POINTS ? 'unchanged' : scoreDelta > 0 ? 'improved' : 'regressed',
    metrics,
    regressions: metrics.filter((m) => m.verdict === 'regressed').map((m) => m.id),
    improvements: metrics.filter((m) => m.verdict === 'improved').map((m) => m.id),
    newFindings: [...afterFindings].filter((id) => !beforeFindings.has(id)),
    resolvedFindings: [...beforeFindings].filter((id) => !afterFindings.has(id)),
    lowConfidence: before.runs < 2 || after.runs < 2,
  };
}
