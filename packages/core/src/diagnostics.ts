import fs from 'node:fs';
import path from 'node:path';
import type { Result } from 'lighthouse';
import type {
  Diagnostics,
  Finding,
  FindingItem,
  LayoutShift,
  LcpElement,
  LongTask,
  MetricSavings,
  SourceAttribution,
} from './types.js';

const MAX_ITEMS_PER_FINDING = 5;

/** Findings driven by server headers that local dev servers typically omit but production servers set. */
const DEV_SERVER_ARTIFACTS = new Set(['cache-insight', 'uses-long-cache-ttl', 'uses-text-compression']);

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

// Lighthouse 13 performance-score weights, used to compare savings across metrics.
// A saving is scored relative to the metric's "good" threshold, so 250ms of LCP and 20ms of TBT are comparable.
const IMPACT_WEIGHTS: Record<keyof Omit<MetricSavings, 'bytes'>, { weight: number; good: number }> = {
  lcp: { weight: 25, good: 2500 },
  fcp: { weight: 10, good: 1800 },
  tbt: { weight: 30, good: 200 },
  cls: { weight: 25, good: 0.1 },
  inp: { weight: 30, good: 200 },
};
// Byte savings without a metric estimate still matter (data cost, slower devices); 100 KiB ~ 1 point.
const BYTES_PER_IMPACT_POINT = 100 * 1024;

type Audit = Result['audits'][string];
type AnyRecord = Record<string, unknown>;

/** Extract ranked findings and supporting diagnostics from one Lighthouse report. */
export function extractDiagnostics(lhr: Result): Diagnostics {
  const refs = lhr.categories.performance?.auditRefs ?? [];
  const findings: Finding[] = [];
  const local = isLocalUrl(lhr.finalDisplayedUrl);
  const thirdParty = thirdPartyOrigins(lhr);
  for (const ref of refs) {
    if (ref.group !== 'insights' && ref.group !== 'diagnostics') continue;
    const audit = lhr.audits[ref.id];
    if (!audit) continue;
    if (audit.score === null || audit.score >= 0.9) continue;
    const finding = toFinding(audit, thirdParty);
    // Dev servers rarely set cache or compression headers; keep the finding visible but rank it last.
    if (local && DEV_SERVER_ARTIFACTS.has(finding.id)) finding.devServerArtifact = true;
    findings.push(finding);
  }
  findings.sort((a, b) => Number(a.devServerArtifact ?? false) - Number(b.devServerArtifact ?? false) || b.impact - a.impact);

  return {
    findings,
    lcpElement: extractLcpElement(lhr),
    layoutShifts: extractLayoutShifts(lhr),
    longTasks: extractLongTasks(lhr),
    sources: extractSourceAttribution(lhr),
  };
}

export function impactScore(savings: MetricSavings): number {
  let score = 0;
  for (const [key, { weight, good }] of Object.entries(IMPACT_WEIGHTS)) {
    const value = savings[key as keyof typeof IMPACT_WEIGHTS];
    if (value) score += (value / good) * weight;
  }
  if (savings.bytes) score += savings.bytes / BYTES_PER_IMPACT_POINT;
  return Math.round(score * 10) / 10;
}

/** Origins Lighthouse classified as belonging to someone other than the audited page. */
function thirdPartyOrigins(lhr: Result): Set<string> {
  return new Set((lhr.entities ?? []).filter((e) => e.isFirstParty !== true).flatMap((e) => e.origins));
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function toFinding(audit: Audit, thirdParty: ReadonlySet<string>): Finding {
  const savings: MetricSavings = {};
  const ms = audit.metricSavings ?? {};
  if (ms.LCP) savings.lcp = ms.LCP;
  if (ms.FCP) savings.fcp = ms.FCP;
  if (ms.TBT) savings.tbt = ms.TBT;
  if (ms.CLS) savings.cls = ms.CLS;
  if (ms.INP) savings.inp = ms.INP;
  const details = audit.details as { overallSavingsBytes?: number; debugData?: { wastedBytes?: number } } | undefined;
  const bytes = details?.overallSavingsBytes ?? details?.debugData?.wastedBytes;
  if (bytes) savings.bytes = bytes;

  return {
    id: audit.id,
    title: audit.title,
    description: audit.description,
    ...(audit.displayValue ? { displayValue: audit.displayValue } : {}),
    savings,
    impact: impactScore(savings),
    items: tableItems(details).slice(0, MAX_ITEMS_PER_FINDING).map((row) => toFindingItem(row, thirdParty)),
  };
}

/** Table rows from a details object; list-type details hold their table one level down. */
function tableItems(details: unknown): AnyRecord[] {
  if (!isRecord(details)) return [];
  if (details.type === 'list' && Array.isArray(details.items)) {
    return details.items.flatMap((sub) => (isRecord(sub) && sub.type === 'table' ? tableItems(sub) : []));
  }
  return Array.isArray(details.items) ? details.items.filter(isRecord) : [];
}

function toFindingItem(row: AnyRecord, thirdParty: ReadonlySet<string>): FindingItem {
  const item: FindingItem = {};
  if (typeof row.url === 'string') {
    item.url = row.url;
    const origin = originOf(row.url);
    if (origin && thirdParty.has(origin)) item.thirdParty = true;
  }
  applyNodeFields(item, row);
  for (const key of ['totalBytes', 'wastedBytes', 'wastedMs', 'duration'] as const) {
    if (typeof row[key] === 'number') item[key] = row[key];
  }
  const sub = isRecord(row.subItems) && Array.isArray(row.subItems.items) ? row.subItems.items.filter(isRecord) : [];
  const notes = sub.map((s) => s.reason ?? s.cause).filter((v): v is string => typeof v === 'string');
  if (notes.length) item.notes = notes;
  const sources = subItemSources(sub);
  if (sources.length) item.sources = sources;
  if (!item.url && !item.selector && typeof row.label === 'string') item.label = row.label;
  return item;
}

function applyNodeFields(item: FindingItem, row: AnyRecord): void {
  const node = isRecord(row.node) && row.node.type === 'node' ? row.node : undefined;
  if (!node) return;
  if (typeof node.selector === 'string') item.selector = node.selector;
  if (typeof node.snippet === 'string') item.snippet = node.snippet;
}

function subItemSources(sub: readonly AnyRecord[]): NonNullable<FindingItem['sources']> {
  return sub
    .filter((s) => typeof s.source === 'string')
    .map((s) => ({
      source: s.source as string,
      ...(typeof s.sourceBytes === 'number' ? { bytes: s.sourceBytes } : {}),
      ...(typeof s.sourceWastedBytes === 'number' ? { wastedBytes: s.sourceWastedBytes } : {}),
    }));
}

function extractLcpElement(lhr: Result): LcpElement | undefined {
  const details: unknown = lhr.audits['lcp-breakdown-insight']?.details;
  if (!isRecord(details) || !Array.isArray(details.items)) return undefined;
  const node = details.items.find((i): i is AnyRecord => isRecord(i) && i.type === 'node');
  if (!node) return undefined;
  const phases = tableItems(details)
    .filter((r) => typeof r.label === 'string' && typeof r.duration === 'number')
    .map((r) => ({ phase: r.label as string, ms: r.duration as number }));
  return {
    selector: str(node.selector),
    snippet: str(node.snippet),
    ...(typeof node.nodeLabel === 'string' ? { label: node.nodeLabel } : {}),
    phases,
  };
}

function extractLayoutShifts(lhr: Result): LayoutShift[] {
  return tableItems(lhr.audits['cls-culprits-insight']?.details)
    .filter((r) => isRecord(r.node) && r.node.type === 'node' && typeof r.score === 'number')
    .map((r) => {
      const node = r.node as AnyRecord;
      const sub = isRecord(r.subItems) && Array.isArray(r.subItems.items) ? r.subItems.items.filter(isRecord) : [];
      return {
        selector: str(node.selector),
        snippet: str(node.snippet),
        score: r.score as number,
        causes: sub.map((s) => {
          const extra = isRecord(s.extra) && typeof s.extra.selector === 'string' ? ` (${s.extra.selector})` : '';
          return `${str(s.cause, 'Unknown cause')}${extra}`;
        }),
      };
    });
}

function extractLongTasks(lhr: Result): LongTask[] {
  return tableItems(lhr.audits['long-tasks']?.details)
    .filter((r) => typeof r.duration === 'number')
    .slice(0, 10)
    .map((r) => ({
      url: typeof r.url === 'string' ? r.url : 'unattributable',
      startMs: typeof r.startTime === 'number' ? Math.round(r.startTime) : 0,
      durationMs: Math.round(r.duration as number),
    }));
}

/** Per-source-file bytes from Lighthouse's source-map-backed script treemap. */
function extractSourceAttribution(lhr: Result): SourceAttribution[] {
  const details: unknown = lhr.audits['script-treemap-data']?.details;
  if (!isRecord(details) || !Array.isArray(details.nodes)) return [];

  const out: SourceAttribution[] = [];
  for (const scriptNode of details.nodes.filter(isRecord)) {
    const script = String(scriptNode.name);
    const children = Array.isArray(scriptNode.children) ? scriptNode.children.filter(isRecord) : [];
    // Scripts without a source map have no children; there's nothing finer-grained to attribute.
    if (children.length === 0) continue;
    const walk = (node: AnyRecord, prefix: string) => {
      const name = prefix ? `${prefix}/${String(node.name)}` : String(node.name);
      const kids = Array.isArray(node.children) ? node.children.filter(isRecord) : [];
      if (kids.length > 0) { kids.forEach((k) => { walk(k, name); }); return; }
      if (name === '(unmapped)') return;
      const pkg = packageName(name);
      out.push({
        script,
        source: name,
        ...(pkg ? { package: pkg } : {}),
        bytes: Number(node.resourceBytes ?? 0),
        unusedBytes: Number(node.unusedBytes ?? 0),
      });
    };
    children.forEach((c) => { walk(c, ''); });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** `.../node_modules/.pnpm/x/node_modules/@scope/pkg/file.js` -> `@scope/pkg` */
export function packageName(source: string): string | undefined {
  const idx = source.lastIndexOf('node_modules/');
  if (idx === -1) return undefined;
  const parts = source.slice(idx + 'node_modules/'.length).split('/');
  if (!parts[0]) return undefined;
  return parts[0].startsWith('@') && parts[1] ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Resolve source-map paths (e.g. `../../src/main.ts`, `webpack://app/./src/x.tsx`) to files in a local project,
 * so findings can point at code the user owns. Mutates and returns the diagnostics.
 */
export function mapSourcesToProject(diagnostics: Diagnostics, projectRoot: string): Diagnostics {
  const cache = new Map<string, string | undefined>();
  const resolve = (source: string) => {
    if (!cache.has(source)) cache.set(source, resolveLocalPath(source, projectRoot));
    return cache.get(source);
  };
  for (const attribution of diagnostics.sources) {
    if (attribution.package) continue;
    const local = resolve(attribution.source);
    if (local) attribution.localPath = local;
  }
  for (const finding of diagnostics.findings) {
    for (const item of finding.items) {
      for (const src of item.sources ?? []) {
        if (packageName(src.source)) continue;
        const local = resolve(src.source);
        if (local) src.localPath = local;
      }
    }
  }
  return diagnostics;
}

export function resolveLocalPath(source: string, projectRoot: string): string | undefined {
  const cleaned = source
    .replace(/^…/, '')
    .replace(/^[a-z][\w+.-]*:\/\/[^/]*\//i, '') // webpack://app/, vite://, file://host/
    .replace(/\?.*$/, '')
    .split('/')
    .filter((seg) => seg !== '..' && seg !== '.' && seg !== '')
    .join('/');
  if (!cleaned || cleaned.includes('node_modules/')) return undefined;
  // Bundlers record paths relative to the output dir, so try progressively shorter suffixes,
  // but never a bare filename (a lone `index.ts` would match the wrong file too easily).
  const segments = cleaned.split('/');
  const shortest = segments.length === 1 ? 1 : 2;
  for (let i = 0; i <= segments.length - shortest; i++) {
    const candidate = segments.slice(i).join('/');
    const full = path.join(projectRoot, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return candidate;
  }
  return undefined;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null;
}

/** Lighthouse detail fields are loosely typed: keep primitives readable, never emit "[object Object]". */
function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return fallback;
}
