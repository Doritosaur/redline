#!/usr/bin/env node
import path from 'node:path';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  audit,
  budgetsSchema,
  checkBudgets,
  checkCompat,
  compareResults,
  fetchFieldData,
  flowStepSchema,
  listRuns,
  loadConfig,
  loadLatestRun,
  measureAcrossBrowsers,
  renderMarkdown,
  resolvePages,
  runFlow,
  saveRun,
  urlTemplate,
  type PageReport,
  type RedlineReport,
} from '@redline/core';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// stdout carries the MCP protocol; anything else written there corrupts it. Log to stderr only.
const server = new McpServer({ name: 'redline', version });

const url = z.url({ protocol: /^https?$/ }).describe('http(s) URL, e.g. http://localhost:3000/');
const preset = z.enum(['mobile', 'desktop']).default('mobile').describe('Device and network emulation profile');
const projectRoot = z
  .string()
  .optional()
  .describe('Absolute path of the project source. Enables mapping bundles back to source files; run history is stored in <projectRoot>/.redline');

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Run a tool body, returning failures as tool errors the model can read instead of crashing the server. */
async function tool(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
  }
}

const historyDir = (root?: string) => path.join(root ?? process.cwd(), '.redline');

server.registerTool(
  'audit_url',
  {
    title: 'Audit page performance',
    description:
      'Run a Lighthouse performance audit in headless Chrome against a live URL or local dev server. Returns score, Core Web Vitals, ' +
      'ranked fixes with estimated savings, the LCP element, layout shifts, long tasks and per-source-file JavaScript cost. ' +
      'Each run is saved, and the result is compared with the previous run of the same URL, so call it again after a code change to verify the fix. ' +
      'Takes ~15-30s per run.',
    inputSchema: {
      url,
      runs: z.number().int().min(1).max(10).default(1).describe('Runs; metrics are medians. Use 3+ when verifying a change, since single runs vary ~10%.'),
      preset,
      projectRoot,
      budgets: budgetsSchema.optional().describe('Optional limits to check, e.g. {"lcp": 2500, "score": 90}'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  ({ url, runs, preset, projectRoot, budgets }) =>
    tool(async () => {
      const dir = historyDir(projectRoot);
      const previous = loadLatestRun(url, preset, dir);
      const result = await audit(url, { runs, preset, ...(projectRoot ? { projectRoot } : {}) });
      saveRun(result, dir);
      const page: PageReport = { result, template: urlTemplate(url), violations: budgets ? checkBudgets(result, budgets) : [], budgetsChecked: Boolean(budgets) };
      if (previous) page.comparison = compareResults(previous, result);
      return renderMarkdown({ generatedAt: new Date().toISOString(), pages: [page] }, { maxFindings: 8 });
    }),
);

server.registerTool(
  'audit_project',
  {
    title: 'Audit all configured pages',
    description:
      "Audit every page from the project's redline.config (pages, sitemap, budgets), comparing each with its previous run. Use when the project has a redline.config file.",
    inputSchema: { projectRoot: z.string().describe('Absolute path of the directory containing redline.config') },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  ({ projectRoot }) =>
    tool(async () => {
      const loaded = await loadConfig(projectRoot);
      if (!loaded) throw new Error(`No redline.config found in ${projectRoot}.`);
      const preset = loaded.config.preset ?? 'mobile';
      const pages: PageReport[] = [];
      for (const pageUrl of await resolvePages(loaded.config)) {
        const previous = loadLatestRun(pageUrl, preset, loaded.historyDir);
        const result = await audit(pageUrl, { runs: loaded.config.runs ?? 1, preset, projectRoot: loaded.projectRoot });
        saveRun(result, loaded.historyDir);
        const budgets = loaded.config.budgets;
        const page: PageReport = { result, template: urlTemplate(pageUrl), violations: budgets ? checkBudgets(result, budgets) : [], budgetsChecked: Boolean(budgets) };
        if (previous) page.comparison = compareResults(previous, result);
        pages.push(page);
      }
      return renderMarkdown({ generatedAt: new Date().toISOString(), pages }, { maxFindings: 5 });
    }),
);

server.registerTool(
  'compare_runs',
  {
    title: 'Compare the last two runs',
    description: 'Compare the two most recent saved audits of a URL, separating real changes from run-to-run noise. Does not run a new audit.',
    inputSchema: { url, preset, projectRoot },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  ({ url, preset, projectRoot }) =>
    tool(async () => {
      const runs = listRuns(url, preset, historyDir(projectRoot));
      if (runs.length < 2) throw new Error(`Need at least two saved runs of ${url} (${preset}); found ${runs.length}. Run audit_url first.`);
      const [before, after] = runs.slice(-2) as [(typeof runs)[0], (typeof runs)[0]];
      const report: RedlineReport = {
        generatedAt: new Date().toISOString(),
        pages: [{ result: after, comparison: compareResults(before, after), violations: [] }],
      };
      return renderMarkdown(report, { maxFindings: 3, details: false });
    }),
);

server.registerTool(
  'cross_browser',
  {
    title: 'Measure in Chromium, Firefox and WebKit',
    description:
      'Load a page in Chromium, Firefox and WebKit (Safari engine) and report each engine’s timings, uncaught JS errors and failed requests. ' +
      'Unthrottled: use it to spot engine-specific slowness or breakage, not for absolute Core Web Vitals.',
    inputSchema: { url, runs: z.number().int().min(1).max(5).default(1) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ url, runs }) =>
    tool(async () => renderMarkdown({ generatedAt: new Date().toISOString(), pages: [], browsers: { url, runs: await measureAcrossBrowsers(url, { runs }) } })),
);

server.registerTool(
  'check_compat',
  {
    title: 'Check browser compatibility',
    description:
      "Statically scan a project's JS/TS/JSX and CSS/SCSS for features its browserslist targets don't support. Returns file:line locations. " +
      'Cannot detect instance methods (e.g. array.toSorted()) that need type information.',
    inputSchema: {
      projectRoot: z.string().describe('Absolute path of the project to scan'),
      browsers: z.array(z.string()).optional().describe('Browserslist queries; defaults to the project’s browserslist config'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  ({ projectRoot, browsers }) =>
    tool(async () =>
      renderMarkdown({ generatedAt: new Date().toISOString(), pages: [], compat: await checkCompat(projectRoot, browsers ? { browsers } : {}) }),
    ),
);

server.registerTool(
  'run_flow',
  {
    title: 'Measure an interaction flow (INP)',
    description:
      'Load a page, then perform scripted steps (click, type, press, scroll, wait, navigate) and measure Interaction to Next Paint, ' +
      'its breakdown (input delay / processing / presentation), the slowest interaction’s target element, and layout shifts during the flow.',
    inputSchema: { url, steps: z.array(flowStepSchema).min(1).describe('e.g. [{"click": "#add-to-cart"}, {"wait": 500}]'), preset },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ url, steps, preset }) =>
    tool(async () => {
      const flow = await runFlow({ name: 'flow', url, steps }, { preset });
      return renderMarkdown({ generatedAt: new Date().toISOString(), pages: [], flows: [flow] });
    }),
);

server.registerTool(
  'field_data',
  {
    title: 'Real-user Core Web Vitals',
    description:
      'Fetch 28-day real-user p75 LCP, INP, CLS, FCP and TTFB from the Chrome UX Report for a public URL (falls back to the whole origin). ' +
      'Requires the CRUX_API_KEY environment variable in the MCP server config. Not available for localhost.',
    inputSchema: { url, preset },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ url, preset }) =>
    tool(async () => {
      const apiKey = process.env.CRUX_API_KEY;
      if (!apiKey) throw new Error('CRUX_API_KEY is not set in the Redline MCP server environment.');
      const data = await fetchFieldData(url, { apiKey, preset });
      if (!data) return `No Chrome UX Report data for ${url} or its origin (not enough real-user Chrome traffic).`;
      return JSON.stringify(data, null, 2);
    }),
);

await server.connect(new StdioServerTransport());
console.error(`redline-mcp ${version} ready on stdio`);
