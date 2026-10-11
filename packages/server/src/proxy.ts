import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { resolvePublic, TargetError } from './net.js';

export interface VettingProxy {
  /** Loopback port the proxy listens on. */
  port: number;
  /**
   * Chrome flags that route every request, including redirects and subresources, through the proxy.
   * Callers must append these after any user-supplied flags so they win: Chrome honors the last
   * occurrence of a switch. `<-loopback>` removes Chrome's implicit proxy bypass for localhost, 127.0.0.0/8, [::1] and
   * link-local addresses (cloud metadata), which would otherwise skip vetting entirely.
   */
  flags: string[];
  close(): Promise<void>;
}

/** How long a plain HTTP exchange may stall before it is cut. Tunnels are not idle-limited: see below. */
const IDLE_TIMEOUT_MS = 120_000;
/** How long a CONNECT may take to reach the vetted address. Once established, the tunnel lives until Chrome or the audit ends. */
const CONNECT_TIMEOUT_MS = 30_000;
const HOP_BY_HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

type Resolve = (hostname: string) => Promise<string>;

const stripBrackets = (host: string) => host.replace(/^\[|\]$/g, '');
const refusalStatus = (err: unknown) => (err instanceof TargetError ? 403 : 400);

async function forwardHttp(req: http.IncomingMessage, res: http.ServerResponse, resolve: Resolve): Promise<void> {
  try {
    const target = new URL(req.url ?? '');
    if (target.protocol !== 'http:') throw new TargetError('Only http and https are proxied.');
    const address = await resolve(stripBrackets(target.hostname));
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
    const upstream = http.request(
      { host: address, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  } catch (err) {
    res.writeHead(refusalStatus(err)).end(err instanceof Error ? err.message : 'Bad request');
  }
}

interface TunnelContext {
  resolve: Resolve;
  /** Live upstream sockets, so closing the proxy can tear them down. */
  tunnels: Set<net.Socket>;
}

async function openTunnel(req: http.IncomingMessage, client: Duplex, head: Buffer, { resolve, tunnels }: TunnelContext): Promise<void> {
  client.on('error', () => client.destroy());
  try {
    const { hostname, port } = new URL(`http://${req.url}`);
    const address = await resolve(stripBrackets(hostname));
    const upstream = net.connect(Number(port) || 443, address, () => {
      upstream.setTimeout(0); // established tunnels (keep-alives, websockets, SSE) may idle; the audit bounds their lifetime
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    tunnels.add(upstream);
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => {
      tunnels.delete(upstream);
      client.destroy();
    });
    client.on('close', () => upstream.destroy());
  } catch (err) {
    client.end(`HTTP/1.1 ${refusalStatus(err)} Refused\r\nConnection: close\r\n\r\n`);
  }
}

/**
 * A local forward proxy that Chrome is pointed at. It resolves each destination itself, refuses
 * internal addresses and connects to the vetted IP, so redirects, subresources and DNS rebinding
 * can't reach the private network. Vetting only the first URL would miss all of those.
 */
export async function startVettingProxy(options: { allowPrivate?: boolean } = {}): Promise<VettingProxy> {
  const resolve: Resolve = (hostname) => resolvePublic(hostname, options);
  const tunnels = new Set<net.Socket>();
  const server = http.createServer((req, res) => void forwardHttp(req, res, resolve));
  server.on('connect', (req, client: Duplex, head) => void openTunnel(req, client, head, { resolve, tunnels }));

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    flags: [`--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>'],
    close: () =>
      new Promise((done) => {
        for (const tunnel of tunnels) tunnel.destroy();
        server.closeAllConnections();
        server.close(() => { done(); });
      }),
  };
}
