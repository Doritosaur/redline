#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { audit } from '@redline/core';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// stdout carries the MCP protocol; anything else written there corrupts it. Log to stderr only.
const server = new McpServer({ name: 'redline', version });

server.registerTool(
  'audit_url',
  {
    title: 'Audit page performance',
    description:
      'Run a Lighthouse performance audit in headless Chrome against a live URL or a local dev server ' +
      '(e.g. http://localhost:3000). Returns the performance score and Core Web Vitals (LCP, FCP, CLS, TBT, ' +
      'Speed Index, TTFB), each rated good / needs-improvement / poor. Each run takes roughly 10-30 seconds.',
    inputSchema: {
      url: z.url({ protocol: /^https?$/ }).describe('http(s) URL to audit'),
      runs: z.number().int().min(1).max(10).default(1).describe('Number of runs; metrics are medians. Use 3+ to compare before/after.'),
      preset: z.enum(['mobile', 'desktop']).default('mobile').describe('Device and network emulation profile'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, runs, preset }) => {
    try {
      const result = await audit(url, { runs, preset });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      };
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`redline-mcp ${version} ready on stdio`);
