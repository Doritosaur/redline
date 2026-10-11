import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { saveRun, type AuditResult } from '@redline/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/server.js';

const result = (fetchedAt: string, lcp: number): AuditResult => ({
  url: 'http://localhost:3000/',
  finalUrl: 'http://localhost:3000/',
  fetchedAt,
  preset: 'mobile',
  runs: 3,
  score: 80,
  lighthouseVersion: '13.5.0',
  metrics: [{ id: 'lcp', label: 'Largest Contentful Paint', value: lcp, unit: 'ms', rating: 'needs-improvement', samples: [lcp, lcp, lcp] }],
  diagnostics: { findings: [], layoutShifts: [], longTasks: [], sources: [] },
});

describe('redline MCP server', () => {
  let client: Client;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-mcp-'));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer('0.0.0-test').connect(serverSide);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[]).map((c) => c.text).join('\n');
    return { isError: Boolean(res.isError), text };
  };

  it('exposes the seven tools, each with a description and input schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['audit_project', 'audit_url', 'check_compat', 'compare_runs', 'cross_browser', 'field_data', 'run_flow'],
    );
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('marks read-only tools so clients can skip approval prompts', async () => {
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(hints).toMatchObject({ compare_runs: true, check_compat: true, audit_url: false, audit_project: false });
  });

  it('compare_runs explains what is missing when there is no history', async () => {
    const res = await call('compare_runs', { url: 'http://localhost:3000/', projectRoot: dir });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/at least two saved runs.*found 0/);
  });

  it('compare_runs compares the two most recent saved runs', async () => {
    const history = path.join(dir, '.redline');
    saveRun(result('2026-10-01T10:00:00.000Z', 4000), history);
    saveRun(result('2026-10-02T10:00:00.000Z', 2400), history);
    const res = await call('compare_runs', { url: 'http://localhost:3000/', projectRoot: dir });
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/LCP|Largest Contentful Paint/);
  });

  it('audit_project fails clearly without a redline.config', async () => {
    const res = await call('audit_project', { projectRoot: dir });
    expect(res).toMatchObject({ isError: true });
    expect(res.text).toContain('No redline.config found');
  });

  it('field_data requires CRUX_API_KEY', async () => {
    const saved = process.env.CRUX_API_KEY;
    delete process.env.CRUX_API_KEY;
    try {
      const res = await call('field_data', { url: 'https://example.com/' });
      expect(res).toMatchObject({ isError: true });
      expect(res.text).toContain('CRUX_API_KEY');
    } finally {
      if (saved !== undefined) process.env.CRUX_API_KEY = saved;
    }
  });

  it('rejects non-http URLs at the schema level', async () => {
    const res = await call('audit_url', { url: 'file:///etc/passwd' }).catch((err: unknown) => ({ isError: true, text: err instanceof Error ? err.message : String(err) }));
    expect(res.isError).toBe(true);
  });
});
