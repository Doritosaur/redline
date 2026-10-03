import { METRICS, rate } from '../src/metrics.js';
import type { AuditResult, MetricId } from '../src/types.js';

/** Build an AuditResult from metric medians, for tests that don't need real Lighthouse output. */
export function fakeResult(
  values: Partial<Record<MetricId, number>>,
  overrides: Partial<AuditResult> = {},
): AuditResult {
  return {
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    fetchedAt: '2026-10-03T10:00:00.000Z',
    preset: 'mobile',
    runs: 3,
    score: 80,
    lighthouseVersion: '13.5.0',
    diagnostics: { findings: [], layoutShifts: [], longTasks: [], sources: [] },
    metrics: METRICS.filter((m) => values[m.id] !== undefined).map((m) => ({
      id: m.id,
      label: m.label,
      unit: m.unit,
      value: values[m.id]!,
      rating: rate(m.id, values[m.id]!),
      samples: [values[m.id]!],
    })),
    ...overrides,
  };
}
