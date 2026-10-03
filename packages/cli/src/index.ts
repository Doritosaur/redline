#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs, styleText } from 'node:util';
import { audit, type AuditResult, type Metric, type Preset, type Rating } from '@redline/core';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const HELP = `redline - frontend performance audits

Usage
  redline <url> [options]

Options
  -n, --runs <n>        Number of runs; metrics are medians (default 1, 3+ recommended)
  -p, --preset <name>   mobile | desktop (default mobile)
      --json            Print the result as JSON
  -h, --help            Show this help
  -v, --version         Show version

Examples
  redline http://localhost:3000
  redline https://example.com --runs 5 --preset desktop
`;

const RATING_STYLE: Record<Rating, Parameters<typeof styleText>[0]> = {
  good: 'green',
  'needs-improvement': 'yellow',
  poor: 'red',
};

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        runs: { type: 'string', short: 'n', default: '1' },
        preset: { type: 'string', short: 'p', default: 'mobile' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    return usageError((err as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  const url = positionals[0];
  if (!url) return usageError('Missing <url>.');
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) return usageError(`--runs must be a positive integer, got "${values.runs}".`);
  if (values.preset !== 'mobile' && values.preset !== 'desktop') {
    return usageError(`--preset must be "mobile" or "desktop", got "${values.preset}".`);
  }
  const preset: Preset = values.preset;

  // Progress goes to stderr so `--json` output on stdout stays machine-readable.
  process.stderr.write(`Auditing ${url} (${preset}, ${runs} run${runs === 1 ? '' : 's'})...\n`);
  const result = await audit(normalizeUrl(url), {
    runs,
    preset,
    onProgress: (done, total) => {
      if (total > 1) process.stderr.write(`  run ${done}/${total} complete\n`);
    },
  });

  process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result));
  return 0;
}

/** Let people type `localhost:3000` without a scheme. */
function normalizeUrl(input: string): string {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
}

function formatReport(result: AuditResult): string {
  const lines = [''];
  const score = result.score === null ? 'n/a' : String(result.score);
  const scoreStyle = result.score === null ? 'dim' : result.score >= 90 ? 'green' : result.score >= 50 ? 'yellow' : 'red';
  lines.push(`${styleText('bold', 'Performance score')}  ${styleText(['bold', scoreStyle], score)}`);
  lines.push(styleText('dim', `${result.finalUrl} · ${result.preset} · median of ${result.runs} run(s) · Lighthouse ${result.lighthouseVersion}`));
  lines.push('');

  const labelWidth = Math.max(...result.metrics.map((m) => m.label.length));
  for (const metric of result.metrics) {
    const value = formatValue(metric).padStart(8);
    const rating = styleText(RATING_STYLE[metric.rating], metric.rating);
    lines.push(`  ${metric.label.padEnd(labelWidth)}  ${value}  ${rating}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatValue(metric: Metric): string {
  if (metric.unit === 'unitless') return metric.value.toFixed(3);
  return metric.value >= 1000 ? `${(metric.value / 1000).toFixed(2)} s` : `${Math.round(metric.value)} ms`;
}

function usageError(message: string): number {
  process.stderr.write(`${message}\n\n${HELP}`);
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${styleText('red', 'Error:')} ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
