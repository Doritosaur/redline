import crypto from 'node:crypto';
import http from 'node:http';
import { audit, renderHtml, urlTemplate, type AuditResult, type Preset } from '@redline/core';
import { TargetError, vetTarget } from './net.js';
import { landingPage, pendingPage } from './pages.js';
import { startVettingProxy, type VettingProxy } from './proxy.js';

export interface ServerOptions {
  /** Allow auditing localhost/private networks. Only for self-hosting inside a trusted network. */
  allowPrivate?: boolean;
  /** When set, POST /api/audits requires `Authorization: Bearer <token>`. */
  apiToken?: string;
  /** Extra Chrome flags, e.g. --no-sandbox in containers. */
  chromeFlags?: string[];
  /** Audits accepted per client IP per hour. Default 20. */
  rateLimitPerHour?: number;
  /** Jobs allowed to wait in the queue. Default 10. */
  maxQueue?: number;
  /** Max runs per audit. Default 3. */
  maxRuns?: number;
  /** Abort an audit that runs longer than this. Default 120000 ms per run. */
  auditTimeoutMs?: number;
  /** Take the client IP from X-Forwarded-For (use only behind a proxy you control). Default false. */
  trustProxy?: boolean;
  /** Override the audit function (tests). */
  auditFn?: typeof audit;
}

type JobStatus = 'queued' | 'running' | 'done' | 'failed';
interface Job {
  id: string;
  url: string;
  preset: Preset;
  runs: number;
  status: JobStatus;
  createdAt: number;
  result?: AuditResult;
  error?: string;
}

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 10 * 1024;

/** A response a route wants sent. Routes return these instead of writing to the socket, so a route can never respond twice. */
interface Reply {
  status: number;
  body: unknown;
  type?: string;
}

const json = (status: number, body: unknown): Reply => ({ status, body });
const html = (status: number, body: string): Reply => ({ status, body, type: 'text/html' });

const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'";

function send(res: http.ServerResponse, { status, body, type = 'application/json' }: Reply): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'x-content-type-options': 'nosniff',
    ...(type === 'text/html' ? { 'content-security-policy': HTML_CSP } : {}),
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function errorReply(err: unknown): Reply {
  return err instanceof TargetError || err instanceof BadRequest ? json(400, { error: err.message }) : json(500, { error: 'Internal error' });
}

interface Runner {
  pump(): Promise<void>;
  isRunning(): boolean;
  close(): void;
}

/** Runs queued jobs one at a time: Chrome is CPU-heavy and concurrent runs skew each other's metrics. */
function createRunner(options: ServerOptions, queue: Job[]): Runner {
  const runAudit = options.auditFn ?? audit;
  const timeoutMs = options.auditTimeoutMs ?? 120_000;
  let running = false;
  let proxy: Promise<VettingProxy> | undefined;

  const execute = async (job: Job): Promise<AuditResult> => {
    // Re-vet at run time: DNS may have changed since the job was queued.
    const target = await vetTarget(job.url, { allowPrivate: options.allowPrivate });
    // Every request Chrome makes goes through a proxy that vets the destination, so redirects
    // and subresources can't reach internal addresses either.
    const vetting = options.allowPrivate ? undefined : await (proxy ??= startVettingProxy());
    return runAudit(target.url, {
      runs: job.runs,
      preset: job.preset,
      // Vetting flags go last: Chrome honors the final occurrence of a switch, so user flags can't bypass the proxy.
      chromeFlags: [...(options.chromeFlags ?? []), ...(vetting?.flags ?? [])],
      // Node's fetch would follow redirects to unvetted hosts; the proxy vets Chrome's requests instead.
      skipReachabilityCheck: !options.allowPrivate,
      signal: AbortSignal.timeout(timeoutMs * job.runs),
    });
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    job.status = 'running';
    try {
      job.result = await execute(job);
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      running = false;
      void pump();
    }
  };

  return {
    pump,
    isRunning: () => running,
    close: () => { void proxy?.then((p) => p.close()); },
  };
}

interface Context {
  options: ServerOptions;
  jobs: Map<string, Job>;
  queue: Job[];
  hits: Map<string, number[]>;
  runner: Runner;
  maxQueue: number;
  maxRuns: number;
  limit: number;
}

/** Drop finished jobs and stale rate-limit entries so a long-lived server doesn't grow without bound. */
function startSweep({ jobs, hits }: Pick<Context, 'jobs' | 'hits'>): NodeJS.Timeout {
  const sweep = setInterval(() => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of jobs) if (job.createdAt < cutoff && job.status !== 'running' && job.status !== 'queued') jobs.delete(id);
    for (const [ip, times] of hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length) hits.set(ip, recent);
      else hits.delete(ip);
    }
  }, 60_000);
  sweep.unref();
  return sweep;
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean | undefined): string {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() : undefined;
  return forwarded || (req.socket.remoteAddress ?? 'unknown');
}

async function createAudit(ctx: Context, req: http.IncomingMessage): Promise<Reply> {
  const { options, jobs, queue, hits } = ctx;
  if (options.apiToken && !safeEqual(req.headers.authorization ?? '', `Bearer ${options.apiToken}`)) {
    return json(401, { error: 'Missing or invalid API token.' });
  }
  const ip = clientIp(req, options.trustProxy);
  const recent = (hits.get(ip) ?? []).filter((t) => t > Date.now() - JOB_TTL_MS);
  if (recent.length >= ctx.limit) return json(429, { error: `Rate limit: ${ctx.limit} audits per hour.` });
  if (queue.length >= ctx.maxQueue) return json(503, { error: 'Too many audits queued. Try again in a minute.' });

  const body = await readJson(req);
  const preset: Preset = body.preset === 'desktop' ? 'desktop' : 'mobile';
  const runs = Math.min(Math.max(1, Math.trunc(Number(body.runs ?? 1)) || 1), ctx.maxRuns);
  const target = await vetTarget(typeof body.url === 'string' ? body.url : '', { allowPrivate: options.allowPrivate });

  const job: Job = { id: crypto.randomUUID(), url: target.url, preset, runs, status: 'queued', createdAt: Date.now() };
  jobs.set(job.id, job);
  queue.push(job);
  hits.set(ip, [...recent, Date.now()]);
  void ctx.runner.pump();
  return json(202, { id: job.id, status: job.status, position: queue.length, statusUrl: `/api/audits/${job.id}`, reportUrl: `/audits/${job.id}` });
}

function auditStatus(ctx: Context, id: string): Reply {
  const job = ctx.jobs.get(id);
  if (!job) return json(404, { error: 'Audit not found or expired.' });
  return json(200, {
    id: job.id,
    url: job.url,
    status: job.status,
    ...(job.status === 'queued' ? { position: ctx.queue.indexOf(job) + 1 } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.result ? { result: job.result } : {}),
  });
}

function auditPage(ctx: Context, id: string): Reply {
  const job = ctx.jobs.get(id);
  if (!job) return html(404, pendingPage('Audit not found or expired.', false));
  if (job.status === 'done' && job.result) {
    return html(200, renderHtml({ generatedAt: job.result.fetchedAt, pages: [{ result: job.result, template: urlTemplate(job.url), violations: [] }] }));
  }
  if (job.status === 'failed') return html(200, pendingPage(`Audit failed: ${job.error ?? 'unknown error'}`, false));
  const where = job.status === 'queued' ? `Queued (position ${ctx.queue.indexOf(job) + 1})` : 'Running';
  return html(200, pendingPage(`${where}: auditing ${job.url}. This page refreshes automatically.`, true));
}

const API_AUDIT = /^\/api\/audits\/([0-9a-f-]{36})$/;
const PAGE_AUDIT = /^\/audits\/([0-9a-f-]{36})$/;

async function route(ctx: Context, req: http.IncomingMessage): Promise<Reply> {
  const { pathname } = new URL(req.url ?? '/', 'http://local');
  if (req.method === 'POST' && pathname === '/api/audits') return createAudit(ctx, req);
  if (req.method !== 'GET') return json(404, { error: 'Not found' });

  if (pathname === '/') return html(200, landingPage());
  if (pathname === '/healthz') return json(200, { ok: true, queued: ctx.queue.length, running: ctx.runner.isRunning() });
  const apiId = API_AUDIT.exec(pathname)?.[1];
  if (apiId) return auditStatus(ctx, apiId);
  const pageId = PAGE_AUDIT.exec(pathname)?.[1];
  if (pageId) return auditPage(ctx, pageId);
  return json(404, { error: 'Not found' });
}

/**
 * Minimal hosted Redline: a queue that runs one audit at a time, with a JSON API and
 * server-rendered report pages.
 */
export function createServer(options: ServerOptions = {}): http.Server {
  const queue: Job[] = [];
  const ctx: Context = {
    options,
    jobs: new Map(),
    queue,
    hits: new Map(),
    runner: createRunner(options, queue),
    maxQueue: options.maxQueue ?? 10,
    maxRuns: options.maxRuns ?? 3,
    limit: options.rateLimitPerHour ?? 20,
  };
  const sweep = startSweep(ctx);

  const server = http.createServer((req, res) => {
    route(ctx, req).catch(errorReply).then((reply) => { send(res, reply); }, () => { res.destroy(); });
  });
  server.on('close', () => {
    clearInterval(sweep);
    ctx.runner.close();
  });
  return server;
}

class BadRequest extends Error {}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof parsed !== 'object' || parsed === null) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new BadRequest('Body must be a JSON object like {"url": "https://example.com"}.');
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
