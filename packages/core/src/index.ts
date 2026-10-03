export { audit, summarize } from './lighthouse.js';
export { METRICS, median, rate } from './metrics.js';
export { extractDiagnostics, impactScore, mapSourcesToProject, packageName, resolveLocalPath } from './diagnostics.js';
export { compareResults, NOISE_THRESHOLDS, type Comparison, type MetricDelta, type Verdict } from './compare.js';
export { DEFAULT_HISTORY_DIR, historyKey, listRuns, loadLatestRun, readResult, saveRun } from './history.js';
export { checkBudgets, type BudgetViolation, type Budgets } from './budgets.js';
export {
  budgetsSchema,
  CONFIG_FILES,
  configSchema,
  flowStepSchema,
  defineConfig,
  loadConfig,
  type BrowserName,
  type FlowConfig,
  type FlowStep,
  type LoadedConfig,
  type RedlineConfig,
} from './config.js';
export { fetchSitemap, groupByTemplate, parseSitemapLocs, resolvePages, samplePerTemplate, toAbsolute, urlTemplate } from './pages.js';
export { measureAcrossBrowsers, type BrowserMetrics, type BrowserRun, type CrossBrowserOptions } from './browsers.js';
export { checkCompat, type CompatIssue, type CompatOptions, type CompatReport } from './compat.js';
export { runFlow, type FlowOptions, type FlowResult } from './flows.js';
export { fetchFieldData, parseRecord, type FieldData, type FieldDataOptions, type FieldMetric, type FieldMetricId } from './crux.js';
export * from './report/index.js';
export type {
  AuditOptions,
  AuditResult,
  Diagnostics,
  Finding,
  FindingItem,
  LayoutShift,
  LcpElement,
  LongTask,
  Metric,
  MetricId,
  MetricSavings,
  Preset,
  Rating,
  SourceAttribution,
} from './types.js';
