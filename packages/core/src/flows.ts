import * as chromeLauncher from 'chrome-launcher';
import { desktopConfig, startFlow, type Result } from 'lighthouse';
import puppeteer, { type Page } from 'puppeteer-core';
import type { FlowConfig, FlowStep } from './config.js';
import { chromeFlagsFromEnv } from './chrome.js';
import { extractDiagnostics } from './diagnostics.js';
import { summarize } from './lighthouse.js';
import { toAbsolute } from './pages.js';
import type { AuditResult, Finding, Preset, Rating } from './types.js';

export interface FlowResult {
  name: string;
  url: string;
  preset: Preset;
  /** Page-load audit of the flow's starting page. */
  navigation: AuditResult;
  /** Metrics observed while the scripted steps ran. */
  interactions: {
    /** Interaction to Next Paint in ms; null when no interaction was registered. */
    inp: number | null;
    inpRating: Rating | null;
    /** Layout shift caused during the steps (excludes the initial load). */
    cls: number | null;
    tbt: number | null;
    /** Where the slowest interaction spent its time: input delay, processing, presentation. */
    inpBreakdown: { phase: string; ms: number }[];
    /** Element the slowest interaction targeted. */
    inpTarget?: string;
    findings: Finding[];
  };
  steps: string[];
}

export interface FlowOptions {
  baseUrl?: string;
  preset?: Preset;
  /** Extra Chrome command-line flags, e.g. `--no-sandbox` inside containers. */
  chromeFlags?: string[];
}

/** Run a scripted user journey and measure responsiveness (INP) and layout stability while it happens. */
export async function runFlow(flow: FlowConfig, options: FlowOptions = {}): Promise<FlowResult> {
  const preset = options.preset ?? 'mobile';
  const url = toAbsolute(flow.url, options.baseUrl);
  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-first-run', ...chromeFlagsFromEnv(), ...(options.chromeFlags ?? [])] });
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  try {
    const page = await browser.newPage();
    const lhFlow = await startFlow(page, {
      name: flow.name,
      flags: { logLevel: 'error', onlyCategories: ['performance'] },
      ...(preset === 'desktop' ? { config: desktopConfig } : {}),
    });

    await lhFlow.navigate(url, { name: `Load ${flow.url}` });
    await lhFlow.startTimespan({ name: 'Interactions' });
    const steps: string[] = [];
    for (const step of flow.steps) steps.push(await runStep(page, step, options.baseUrl ?? url));
    // Let the last interaction's next paint land before the timespan closes.
    await new Promise((r) => setTimeout(r, 500));
    await lhFlow.endTimespan();

    const result = await lhFlow.createFlowResult();
    const [navStep, timespanStep] = result.steps;
    if (!navStep || !timespanStep) throw new Error(`Flow "${flow.name}" produced no results`);
    if (navStep.lhr.runtimeError) throw new Error(`Could not load ${url}: ${navStep.lhr.runtimeError.message}`);

    return {
      name: flow.name,
      url,
      preset,
      navigation: summarize(url, preset, [navStep.lhr]),
      interactions: summarizeTimespan(timespanStep.lhr),
      steps,
    };
  } finally {
    await browser.disconnect();
    chrome.kill();
  }
}

async function runStep(page: Page, step: FlowStep, baseUrl: string): Promise<string> {
  if ('click' in step) {
    await page.waitForSelector(step.click, { visible: true, timeout: 15_000 });
    await page.click(step.click);
    return `click ${step.click}`;
  }
  if ('type' in step) {
    await page.waitForSelector(step.type.selector, { visible: true, timeout: 15_000 });
    await page.type(step.type.selector, step.type.text, { delay: 30 });
    return `type into ${step.type.selector}`;
  }
  if ('press' in step) {
    await page.keyboard.press(step.press as Parameters<Page['keyboard']['press']>[0]);
    return `press ${step.press}`;
  }
  if ('wait' in step) {
    await new Promise((r) => setTimeout(r, step.wait));
    return `wait ${step.wait}ms`;
  }
  if ('scroll' in step) {
    await page.mouse.wheel({ deltaY: step.scroll });
    await new Promise((r) => setTimeout(r, 300));
    return `scroll ${step.scroll}px`;
  }
  const target = toAbsolute(step.navigate, baseUrl);
  await page.goto(target, { waitUntil: 'load' });
  return `navigate ${step.navigate}`;
}

function summarizeTimespan(lhr: Result): FlowResult['interactions'] {
  const numeric = (id: string) => {
    const v = lhr.audits[id]?.numericValue;
    return typeof v === 'number' ? v : null;
  };
  const inp = numeric('interaction-to-next-paint');
  const breakdown = inpBreakdown(lhr);
  return {
    inp,
    inpRating: inp === null ? null : inp <= 200 ? 'good' : inp <= 500 ? 'needs-improvement' : 'poor',
    cls: numeric('cumulative-layout-shift'),
    tbt: numeric('total-blocking-time'),
    inpBreakdown: breakdown.phases,
    ...(breakdown.target ? { inpTarget: breakdown.target } : {}),
    // The INP breakdown is already reported above as inpBreakdown/inpTarget.
    findings: extractDiagnostics(lhr).findings.filter((f) => f.id !== 'inp-breakdown-insight'),
  };
}

function inpBreakdown(lhr: Result): { phases: { phase: string; ms: number }[]; target?: string } {
  const details = lhr.audits['inp-breakdown-insight']?.details as unknown;
  const lists = isRecord(details) && Array.isArray(details.items) ? details.items.filter(isRecord) : [];
  const phases: { phase: string; ms: number }[] = [];
  let target: string | undefined;
  for (const entry of lists) {
    if (entry.type === 'node' && typeof entry.selector === 'string') target = entry.selector;
    if (entry.type === 'table' && Array.isArray(entry.items)) {
      for (const row of entry.items.filter(isRecord)) {
        if (typeof row.label === 'string' && typeof row.duration === 'number') phases.push({ phase: row.label, ms: row.duration });
      }
    }
  }
  return target ? { phases, target } : { phases };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
