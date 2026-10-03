import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const metricBudget = z.number().nonnegative();

export const budgetsSchema = z.strictObject({
  score: z.number().min(0).max(100).optional().describe('Minimum performance score (0-100)'),
  lcp: metricBudget.optional(),
  fcp: metricBudget.optional(),
  cls: metricBudget.optional(),
  tbt: metricBudget.optional(),
  si: metricBudget.optional(),
  ttfb: metricBudget.optional(),
});

export const flowStepSchema = z.union([
  z.strictObject({ click: z.string().describe('CSS selector to click') }),
  z.strictObject({ type: z.strictObject({ selector: z.string(), text: z.string() }) }),
  z.strictObject({ press: z.string().describe('Key to press, e.g. "Enter"') }),
  z.strictObject({ wait: z.number().int().min(0).max(60_000).describe('Milliseconds to wait') }),
  z.strictObject({ scroll: z.number().describe('Pixels to scroll down (negative scrolls up)') }),
  z.strictObject({ navigate: z.string().describe('URL or path to navigate to') }),
]);

export const flowSchema = z.strictObject({
  name: z.string().min(1),
  /** Page the flow starts on; relative paths resolve against `baseUrl`. */
  url: z.string(),
  steps: z.array(flowStepSchema).min(1),
});

export const browserNameSchema = z.enum(['chromium', 'firefox', 'webkit']);

export const configSchema = z.strictObject({
  /** Origin that relative `pages` and flow URLs resolve against, e.g. http://localhost:3000 */
  baseUrl: z.url().optional(),
  /** Pages to audit: paths (resolved against baseUrl) or absolute URLs. */
  pages: z.array(z.string()).optional(),
  /** Discover pages from a sitemap (path or absolute URL). */
  sitemap: z.union([z.string(), z.strictObject({ url: z.string(), limit: z.number().int().positive().optional() })]).optional(),
  /** Audit at most this many pages per URL template (e.g. /products/:id). */
  perTemplate: z.number().int().positive().optional(),
  preset: z.enum(['mobile', 'desktop']).optional(),
  runs: z.number().int().min(1).max(20).optional(),
  budgets: budgetsSchema.optional(),
  /** In `redline ci`, fail when a metric regresses against the baseline even if budgets pass. */
  failOnRegression: z.boolean().optional(),
  flows: z.array(flowSchema).optional(),
  browsers: z.array(browserNameSchema).optional(),
  /** Project source directory, for mapping bundles back to files. Defaults to the config file's directory. */
  projectRoot: z.string().optional(),
  /** Where run history and baselines are stored. Default `.redline` next to the config. */
  historyDir: z.string().optional(),
});

export type RedlineConfig = z.infer<typeof configSchema>;
export type FlowConfig = z.infer<typeof flowSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;
export type BrowserName = z.infer<typeof browserNameSchema>;

/** Identity helper that gives `redline.config.ts` type checking and autocomplete. */
export function defineConfig(config: RedlineConfig): RedlineConfig {
  return config;
}

export const CONFIG_FILES = ['redline.config.ts', 'redline.config.mts', 'redline.config.js', 'redline.config.mjs', 'redline.config.json'];

export interface LoadedConfig {
  config: RedlineConfig;
  /** Absolute path of the file it came from. */
  file: string;
  /** Absolute project root (config `projectRoot`, or the config file's directory). */
  projectRoot: string;
  /** Absolute history directory. */
  historyDir: string;
}

/** Find and load the nearest Redline config in `cwd`. Returns undefined when there is none. */
export async function loadConfig(cwd = process.cwd(), explicitFile?: string): Promise<LoadedConfig | undefined> {
  const file = explicitFile
    ? path.resolve(cwd, explicitFile)
    : CONFIG_FILES.map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f));
  if (!file) return undefined;
  if (!fs.existsSync(file)) throw new Error(`Config file not found: ${file}`);

  let raw: unknown;
  try {
    if (file.endsWith('.json')) {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      // Node 22.18+/24 strips TypeScript types natively, so .ts configs load without a build step.
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
      raw = mod.default ?? mod;
    }
  } catch (err) {
    throw new Error(`Could not load ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid ${path.basename(file)}:\n${issues}`);
  }
  const dir = path.dirname(file);
  return {
    config: parsed.data,
    file,
    projectRoot: path.resolve(dir, parsed.data.projectRoot ?? '.'),
    historyDir: path.resolve(dir, parsed.data.historyDir ?? '.redline'),
  };
}
