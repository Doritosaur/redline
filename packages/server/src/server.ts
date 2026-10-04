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

/**
 * Minimal hosted Redline: a queue that runs one audit at a time (Chrome is CPU-heavy and
 * concurrent runs skew each other's metrics), with a JSON API and server-rendered report pages.
 */
export function createServer(options: ServerOptions = {}): http.Server {
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  const hits = new Map<string, number[]>();
  const runAudit = options.auditFn ?? audit;
  const maxQueue = options.maxQueue ?? 10;
  const maxRuns = options.maxRuns ?? 3;
  const limit = options.rateLimitPerHour ?? 20;
  const timeoutMs = options.auditTimeoutMs ?? 120_000;
  let running = false;
  let proxy: Promise<VettingProxy> | undefined;

  const pump = async () => {
    if (running) return;
    const job = queue.shift();
    if (!job) return;
    running = true;
    job.status = 'running';
    try {
      // Re-vet at run time: DNS may have changed since the job was queued.
      const target = await vetTarget(job.url, { allowPrivate: options.allowPrivate });
      // Every request Chrome makes goes through a proxy that vets the destination, so redirects
      // and subresources can't reach internal addresses either.
      const vetting = options.allowPrivate ? undefined : await (proxy ??= startVettingProxy());
      job.result = await runAudit(target.url, {
        runs: job.runs,
        preset: job.preset,
        chromeFlags: [...(options.chromeFlags ?? []), ...(vetting ? [vetting.flag] : [])],
        // Node's fetch would follow redirects to unvetted hosts; the proxy vets Chrome's requests instead.
        skipReachabilityCheck: !options.allowPrivate,
        signal: AbortSignal.timeout(timeoutMs * job.runs),
      });
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      running = false;
      void pump();
    }
  };

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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, {
        'content-type': `${type}; charset=utf-8`,
        'x-content-type-options': 'nosniff',
        ...(type === 'text/html' ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'" } : {}),
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, landingPage(), 'text/html');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true, queued: queue.length, running });

      if (req.method === 'POST' && url.pathname === '/api/audits') {
        if (options.apiToken && !safeEqual(req.headers.authorization ?? '', `Bearer ${options.apiToken}`)) {
          return send(401, { error: 'Missing or invalid API token.' });
        }
        const forwarded = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() : undefined;
        const ip = forwarded || (req.socket.remoteAddress ?? 'unknown');
        const recent = (hits.get(ip) ?? []).filter((t) => t > Date.now() - JOB_TTL_MS);
        if (recent.length >= limit) return send(429, { error: `Rate limit: ${limit} audits per hour.` });
        if (queue.length >= maxQueue) return send(503, { error: 'Too many audits queued. Try again in a minute.' });

        const body = await readJson(req);
        const preset: Preset = body.preset === 'desktop' ? 'desktop' : 'mobile';
        const runs = Math.min(Math.max(1, Math.trunc(Number(body.runs ?? 1)) || 1), maxRuns);
        const target = await vetTarget(String(body.url ?? ''), { allowPrivate: options.allowPrivate });

        const job: Job = { id: crypto.randomUUID(), url: target.url, preset, runs, status: 'queued', createdAt: Date.now() };
        jobs.set(job.id, job);
        queue.push(job);
        hits.set(ip, [...recent, Date.now()]);
        void pump();
        return send(202, { id: job.id, status: job.status, position: queue.length, statusUrl: `/api/audits/${job.id}`, reportUrl: `/audits/${job.id}` });
      }

      const apiMatch = /^\/api\/audits\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && apiMatch) {
        const job = jobs.get(apiMatch[1]!);
        if (!job) return send(404, { error: 'Audit not found or expired.' });
        return send(200, {
          id: job.id,
          url: job.url,
          status: job.status,
          ...(job.status === 'queued' ? { position: queue.indexOf(job) + 1 } : {}),
          ...(job.error ? { error: job.error } : {}),
          ...(job.result ? { result: job.result } : {}),
        });
      }

      const pageMatch = /^\/audits\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && pageMatch) {
        const job = jobs.get(pageMatch[1]!);
        if (!job) return send(404, pendingPage('Audit not found or expired.', false), 'text/html');
        if (job.status === 'done' && job.result) {
          return send(200, renderHtml({ generatedAt: job.result.fetchedAt, pages: [{ result: job.result, template: urlTemplate(job.url), violations: [] }] }), 'text/html');
        }
        if (job.status === 'failed') return send(200, pendingPage(`Audit failed: ${job.error ?? 'unknown error'}`, false), 'text/html');
        const where = job.status === 'queued' ? `Queued (position ${queue.indexOf(job) + 1})` : 'Running';
        return send(200, pendingPage(`${where}: auditing ${job.url}. This page refreshes automatically.`, true), 'text/html');
      }

      return send(404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof TargetError || err instanceof BadRequest) return send(400, { error: err.message });
      return send(500, { error: 'Internal error' });
    }
  });
  server.on('close', () => {
    clearInterval(sweep);
    void proxy?.then((p) => p.close());
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
