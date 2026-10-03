import { METRICS } from './metrics.js';
import type { AuditResult, MetricId } from './types.js';

/** Upper limits per metric (ms, CLS unitless) and a minimum performance score. */
export type Budgets = Partial<Record<MetricId, number>> & { score?: number };

export interface BudgetViolation {
  url: string;
  metric: MetricId | 'score';
  label: string;
  limit: number;
  actual: number;
}

export function checkBudgets(result: AuditResult, budgets: Budgets): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  if (budgets.score !== undefined && result.score !== null && result.score < budgets.score) {
    violations.push({ url: result.url, metric: 'score', label: 'Performance score', limit: budgets.score, actual: result.score });
  }
  for (const def of METRICS) {
    const limit = budgets[def.id];
    const metric = result.metrics.find((m) => m.id === def.id);
    if (limit === undefined || !metric) continue;
    if (metric.value > limit) {
      violations.push({ url: result.url, metric: def.id, label: def.label, limit, actual: metric.value });
    }
  }
  return violations;
}
