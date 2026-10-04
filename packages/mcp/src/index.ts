#!/usr/bin/env node
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

await createMcpServer(version).connect(new StdioServerTransport());
console.error(`redline-mcp ${version} ready on stdio`);
