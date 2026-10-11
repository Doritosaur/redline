import type { AddressInfo } from 'node:net';
import http from 'node:http';
import net from 'node:net';
import type { AuditOptions, AuditResult } from '@redline/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPrivateAddress, vetTarget } from '../src/net.js';
import { startVettingProxy } from '../src/proxy.js';
import { createServer, type ServerOptions } from '../src/server.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', 'not-an-ip',
    // IPv6 forms that embed an IPv4 address
    '::7f00:1', '::127.0.0.1', '::a9fe:a9fe', '::ffff:0:7f00:1', '::ffff:0:127.0.0.1', '2002:7f00:1::1', '2002:a9fe:a9fe::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '0:0:0:0:0:ffff:7f00:1', '[::1]',
  ])('refuses %s', (ip) => { expect(isPrivateAddress(ip)).toBe(true); });

  it.each(['93.184.215.14', '172.32.0.1', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808', '::808:808', '2002:808:808::1', '2001:4860:4860::8888'])('allows public %s', (ip) => { expect(isPrivateAddress(ip)).toBe(false); },
  );
});

describe('vetTarget', () => {
  it('rejects private targets, credentials and non-http schemes with clear messages', async () => {
    await expect(vetTarget('http://localhost:3000')).rejects.toThrow(/private or internal/);
    await expect(vetTarget('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private or internal/);
    await expect(vetTarget('http://[::1]/')).rejects.toThrow(/private or internal/);
    await expect(vetTarget('file:///etc/passwd')).rejects.toThrow(/Only http and https/);
    await expect(vetTarget('https://user:pw@example.com')).rejects.toThrow(/credentials/);
    await expect(vetTarget('example.com')).rejects.toThrow(/full URL/);
  });

  it('allows private targets when self-hosting opts in, ', async () => {
    const t = await vetTarget('http://127.0.0.1:4321/x', { allowPrivate: true });
    expect(t).toMatchObject({ hostname: '127.0.0.1', address: '127.0.0.1' });
  });
});

describe('server', () => {
  let server: http.Server | undefined;
  afterEach(() => server?.close());

  const fakeResult = (url: string): AuditResult => ({
    url, finalUrl: url, fetchedAt: '2026-10-03T10:00:00.000Z', preset: 'mobile', runs: 1, score: 77, lighthouseVersion: '13.5.0',
    metrics: [], diagnostics: { findings: [], layoutShifts: [], longTasks: [], sources: [] },
  });

  async function start(options: ServerOptions) {
    server = createServer(options);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/audits`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { base, post };
  }

  it('queues an audit, runs it through the vetting proxy, and serves JSON and HTML results', async () => {
    const auditFn = vi.fn(async (url: string, _opts?: AuditOptions) => fakeResult(url));
    // Public-mode vetting needs a resolvable public host; 93.184.215.14 is a literal public IP.
    const { base, post } = await start({ auditFn: auditFn });
    const res = await post({ url: 'http://93.184.215.14/', runs: 99, preset: 'desktop' });
    expect(res.status).toBe(202);
    const { id, reportUrl } = (await res.json()) as { id: string; reportUrl: string };

    await vi.waitFor(async () => { expect(((await (await fetch(`${base}/api/audits/${id}`)).json()) as { status: string }).status).toBe('done'); });
    const [, opts] = auditFn.mock.calls[0]!;
    expect(opts).toMatchObject({ runs: 3, preset: 'desktop', skipReachabilityCheck: true });
    expect(opts?.chromeFlags).toEqual([expect.stringMatching(/^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/), '--proxy-bypass-list=<-loopback>']);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);

    const html = await (await fetch(`${base}${reportUrl}`)).text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('77');
  });

  it('refuses private targets with 400 before queueing', async () => {
    const auditFn = vi.fn();
    const { post } = await start({ auditFn: auditFn as never });
    const res = await post({ url: 'http://localhost:3000' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/private/);
    expect(auditFn).not.toHaveBeenCalled();
  });

  it('enforces the API token and per-client rate limit', async () => {
    const { post } = await start({ apiToken: 's3cret', rateLimitPerHour: 1, allowPrivate: true, auditFn: (async (u: string) => fakeResult(u)) });
    expect((await post({ url: 'http://127.0.0.1:1/' })).status).toBe(401);
    expect((await post({ url: 'http://127.0.0.1:1/' }, { authorization: 'Bearer s3cret' })).status).toBe(202);
    expect((await post({ url: 'http://127.0.0.1:1/' }, { authorization: 'Bearer s3cret' })).status).toBe(429);
  });

  it('rejects malformed bodies and reports failures', async () => {
    const { base, post } = await start({ allowPrivate: true, auditFn: (async () => { throw new Error('Chrome crashed'); }) });
    const bad = await fetch(`${base}/api/audits`, { method: 'POST', body: 'nope' });
    expect(bad.status).toBe(400);
    const { id } = (await (await post({ url: 'http://127.0.0.1:1/' })).json()) as { id: string };
    await vi.waitFor(async () => { expect(await (await fetch(`${base}/api/audits/${id}`)).json()).toMatchObject({ status: 'failed', error: 'Chrome crashed' }); });
  });

  it('aborts audits that exceed the timeout', async () => {
    const auditFn = vi.fn(
      (_url: string, opts?: AuditOptions) => new Promise<AuditResult>((_, reject) => opts?.signal?.addEventListener('abort', () => { reject(new Error(String(opts.signal?.reason))); })),
    );
    const { base, post } = await start({ allowPrivate: true, auditTimeoutMs: 50, auditFn: auditFn });
    const { id } = (await (await post({ url: 'http://127.0.0.1:1/' })).json()) as { id: string };
    await vi.waitFor(async () => { expect(await (await fetch(`${base}/api/audits/${id}`)).json()).toMatchObject({ status: 'failed' }); });
  });

  it('rate limits by X-Forwarded-For only when trustProxy is set', async () => {
    const auditFn = (async (u: string) => fakeResult(u)) as never;
    const off = await start({ allowPrivate: true, rateLimitPerHour: 1, auditFn });
    expect((await off.post({ url: 'http://127.0.0.1:1/' }, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(202);
    expect((await off.post({ url: 'http://127.0.0.1:1/' }, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
    server?.close();
    const on = await start({ allowPrivate: true, rateLimitPerHour: 1, trustProxy: true, auditFn });
    expect((await on.post({ url: 'http://127.0.0.1:1/' }, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(202);
    expect((await on.post({ url: 'http://127.0.0.1:1/' }, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(202);
    expect((await on.post({ url: 'http://127.0.0.1:1/' }, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
  });
});

describe('vetting proxy', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => { r((s.address() as AddressInfo).port); }));

  it('refuses plain requests and CONNECT tunnels to internal addresses, including redirect targets', async () => {
    const upstream = http.createServer((_, res) => res.end('secret'));
    const upstreamPort = await listen(upstream);
    closers.push(() => upstream.close());
    const proxy = await startVettingProxy();
    closers.push(proxy.close);
    const port = proxy.port;

    const plain = await new Promise<number>((resolve) =>
      http.get({ host: '127.0.0.1', port, path: `http://127.0.0.1:${upstreamPort}/`, headers: { host: `127.0.0.1:${upstreamPort}` } }, (res) => { resolve(res.statusCode!); }),
    );
    expect(plain).toBe(403);

    const metadata = await new Promise<number>((resolve) =>
      http.get({ host: '127.0.0.1', port, path: 'http://169.254.169.254/latest/meta-data' }, (res) => { resolve(res.statusCode!); }),
    );
    expect(metadata).toBe(403);

    const connect = await new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: x\r\n\r\n`));
      socket.once('data', (d) => { socket.destroy(); resolve(d.toString()); });
    });
    expect(connect).toMatch(/^HTTP\/1\.1 403/);
  });

  it('forwards to vetted destinations when private targets are allowed', async () => {
    const upstream = http.createServer((req, res) => res.end(`hello ${req.url}`));
    const upstreamPort = await listen(upstream);
    closers.push(() => upstream.close());
    const proxy = await startVettingProxy({ allowPrivate: true });
    closers.push(proxy.close);

    const body = await new Promise<string>((resolve) =>
      http.get({ host: '127.0.0.1', port: proxy.port, path: `http://127.0.0.1:${upstreamPort}/a?b=1` }, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => { resolve(data); });
      }),
    );
    expect(body).toBe('hello /a?b=1');
  });
});
