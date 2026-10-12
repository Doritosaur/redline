import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { renderMarkdown, type RedlineReport } from '@redline/core';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface ExplainOptions {
  /** Project directory, used to read the source files the report points at. */
  projectRoot?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Called with each chunk of the answer as it streams. */
  onText?: (chunk: string) => void;
  client?: Anthropic;
  /** Max bytes of source code to send in total. Default 200 KB. */
  maxSourceBytes?: number;
}

export interface ExplainResult {
  markdown: string;
  /** Model that produced the answer (differs from the requested one if a fallback ran). */
  model: string;
  includedFiles: string[];
  /** Files that were relevant but didn't fit the size budget. */
  omittedFiles: string[];
  usage: { inputTokens: number; outputTokens: number };
}

const MAX_FILE_BYTES = 60 * 1024;

const SYSTEM_PROMPT = `You are Redline's performance engineer. You receive a frontend performance report (Lighthouse lab data, ranked findings with estimated savings, source-map attribution, layout shifts, long tasks, and optionally cross-browser, compatibility, user-flow and real-user data) together with the project's source files that the report points at.

Your job is to tell the developer exactly what to change in their code, in priority order, and why.

For each recommendation:
- Name the root cause and cite the specific evidence from the report (metric, selector, file, bytes or milliseconds).
- Give the concrete change. When the relevant file is included, show it as a unified diff against that file using its exact path. When it is not included, say which file you would expect to change and describe the change; do not invent file contents.
- State the expected effect using the report's own savings estimates where they exist, and say when an effect is uncertain.

Order recommendations by expected impact on the metrics that are failing. Skip findings whose savings are negligible. Point out when a problem is likely a measurement artifact of the test setup (for example, missing cache headers on a local dev server) rather than a production issue.

End with a short "Verify" section: how to confirm the fixes worked, e.g. re-running \`redline <url> --runs 3\`, which compares against the previous run automatically.

Write in GitHub-flavored Markdown. Be direct and specific; no generic performance advice that the report does not support.`;

/** Anthropic credentials are missing or rejected. */
export class MissingCredentialsError extends Error {}

/**
 * Fail fast, before a multi-minute audit, when there is nothing to authenticate with. Only auth problems throw:
 * a network blip here is left for the real request to report.
 */
export async function assertCredentials(client: Anthropic = new Anthropic()): Promise<void> {
  try {
    await client.models.list({ limit: 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Anthropic.AuthenticationError || message.includes('Could not resolve authentication')) {
      throw new MissingCredentialsError('Anthropic credentials not found or rejected. Set ANTHROPIC_API_KEY, or run `ant auth login`.');
    }
  }
}

/** Ask Claude to turn a Redline report into prioritized, code-level fixes. */
export async function explainReport(report: RedlineReport, options: ExplainOptions = {}): Promise<ExplainResult> {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_MODEL;
  const sources = collectSources(report, options.projectRoot, options.maxSourceBytes ?? 200 * 1024);

  const fileBlocks = sources.included.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join('\n\n');
  const omitted = sources.omitted.length
    ? `\n\nThese relevant files were not included because of size limits: ${sources.omitted.join(', ')}`
    : '';
  const noSources = options.projectRoot
    ? sources.included.length === 0
      ? '\n\nNo local source files could be matched to this report (the site may not ship source maps).'
      : ''
    : '\n\nNo project directory was provided, so no source files are included.';

  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64_000,
    // Opus 5.5 always thinks adaptively; effort is the depth control and defaults to medium on this model.
    output_config: { effort: options.effort ?? 'high' },
    // On a safety decline, re-run on a fallback model chosen by the API instead of failing.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `<report>\n${renderMarkdown(report, { maxFindings: 10 })}\n</report>${fileBlocks ? `\n\n<sources>\n${fileBlocks}\n</sources>` : ''}${omitted}${noSources}\n\nWhat should I change, in order?`,
      },
    ],
  });
  if (options.onText) stream.on('text', options.onText);
  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category ? ` (${message.stop_details.category})` : '';
    throw new Error(`Claude declined to answer${category}.`);
  }
  const markdown = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (message.stop_reason === 'max_tokens') {
    throw new Error('The answer hit the output limit before finishing. Try a report with fewer pages.');
  }

  return {
    markdown,
    model: message.model,
    includedFiles: sources.included.map((f) => f.path),
    omittedFiles: sources.omitted,
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
  };
}

interface SourceFile {
  path: string;
  content: string;
}

/** Local files the report points at, most relevant first, within a byte budget. */
export function collectSources(
  report: RedlineReport,
  projectRoot: string | undefined,
  budget: number,
): { included: SourceFile[]; omitted: string[] } {
  if (!projectRoot) return { included: [], omitted: [] };
  const ranked = new Map<string, number>();
  const add = (p: string | undefined, weight: number) => {
    if (p) ranked.set(p, (ranked.get(p) ?? 0) + weight);
  };
  for (const page of report.pages) {
    const d = page.result.diagnostics;
    d.findings.forEach((f, i) => {
      for (const item of f.items) for (const s of item.sources ?? []) add(s.localPath, f.impact + 10 - i);
    });
    for (const s of d.sources) add(s.localPath, s.unusedBytes / 1024 + s.bytes / 10_240);
  }
  for (const issue of report.compat?.issues ?? []) add(issue.file, 1);

  const root = realpathOrUndefined(path.resolve(projectRoot));
  const byRelevance = [...ranked.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  // An unreadable root must be visible: report every referenced file as omitted rather than silently sending none.
  if (!root) return { included: [], omitted: byRelevance };
  const included: SourceFile[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const rel of byRelevance) {
    // Never read outside the project, whatever a source map claims or a symlink points at.
    const full = realpathOrUndefined(path.resolve(projectRoot, rel));
    if (!full || !isInside(root, full)) continue;
    const size = fs.statSync(full).size;
    if (size > MAX_FILE_BYTES || used + size > budget) {
      omitted.push(rel);
      continue;
    }
    included.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
    used += size;
  }
  return { included, omitted };
}

/** True when `child` is strictly inside `parent`. Both must already be real paths. Works for filesystem roots, unlike a `startsWith(parent + sep)` check. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

function realpathOrUndefined(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}
