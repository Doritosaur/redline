import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { resolvePublic, TargetError } from './net.js';

export interface VettingProxy {
  /** Chrome flag that routes every request, including redirects and subresources, through the proxy. */
  flag: string;
  close(): Promise<void>;
}

const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

/**
 * A local forward proxy that Chrome is pointed at. It resolves each destination itself, refuses
 * internal addresses and connects to the vetted IP, so redirects, subresources and DNS rebinding
 * can't reach the private network. Vetting only the first URL would miss all of those.
 */
export async function startVettingProxy(options: { allowPrivate?: boolean } = {}): Promise<VettingProxy> {
  const server = http.createServer(async (req, res) => {
    try {
      const target = new URL(req.url ?? '');
      if (target.protocol !== 'http:') throw new TargetError('Only http and https are proxied.');
      const address = await resolvePublic(target.hostname.replace(/^\[|\]$/g, ''), options);
      const headers = { ...req.headers };
      for (const name of HOP_BY_HOP) delete headers[name];
      const upstream = http.request(
        { host: address, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => res.headersSent || res.writeHead(502).end());
      req.pipe(upstream);
    } catch (err) {
      res.writeHead(err instanceof TargetError ? 403 : 400).end(err instanceof Error ? err.message : 'Bad request');
    }
  });

  server.on('connect', async (req, client: Duplex, head) => {
    client.on('error', () => client.destroy());
    try {
      const { hostname, port } = new URL(`http://${req.url}`);
      const address = await resolvePublic(hostname.replace(/^\[|\]$/g, ''), options);
      const upstream = net.connect(Number(port) || 443, address, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    } catch (err) {
      client.end(`HTTP/1.1 ${err instanceof TargetError ? 403 : 400} Refused\r\nConnection: close\r\n\r\n`);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    flag: `--proxy-server=http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
