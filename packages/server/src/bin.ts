#!/usr/bin/env node
import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 8080);
const allowPrivate = process.env.REDLINE_ALLOW_PRIVATE === '1';

const server = createServer({
  allowPrivate,
  ...(process.env.REDLINE_API_TOKEN ? { apiToken: process.env.REDLINE_API_TOKEN } : {}),
  chromeFlags: (process.env.REDLINE_CHROME_FLAGS ?? '').split(' ').filter(Boolean),
  ...(process.env.REDLINE_RATE_LIMIT ? { rateLimitPerHour: Number(process.env.REDLINE_RATE_LIMIT) } : {}),
});

server.listen(port, () => {
  console.log(`Redline server on http://localhost:${port}`);
  if (allowPrivate) console.warn('REDLINE_ALLOW_PRIVATE=1: localhost and private-network URLs can be audited. Do not expose this publicly.');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
