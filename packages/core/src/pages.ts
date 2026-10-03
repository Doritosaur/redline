import type { RedlineConfig } from './config.js';

const DEFAULT_SITEMAP_LIMIT = 50;

/** Resolve the configured pages (explicit list plus sitemap) to absolute URLs, de-duplicated, in order. */
export async function resolvePages(config: RedlineConfig): Promise<string[]> {
  const urls: string[] = [];
  for (const page of config.pages ?? []) urls.push(toAbsolute(page, config.baseUrl));
  if (config.sitemap) {
    const spec = typeof config.sitemap === 'string' ? { url: config.sitemap } : config.sitemap;
    urls.push(...(await fetchSitemap(toAbsolute(spec.url, config.baseUrl), spec.limit ?? DEFAULT_SITEMAP_LIMIT)));
  }
  if (urls.length === 0 && config.baseUrl) urls.push(config.baseUrl);
  const unique = [...new Set(urls)];
  return config.perTemplate ? samplePerTemplate(unique, config.perTemplate) : unique;
}

export function toAbsolute(page: string, baseUrl?: string): string {
  if (/^https?:\/\//i.test(page)) return page;
  if (!baseUrl) throw new Error(`"${page}" is a relative path; set baseUrl in your Redline config.`);
  return new URL(page, baseUrl).href;
}

/** Fetch a sitemap (following one level of sitemap indexes) and return up to `limit` page URLs. */
export async function fetchSitemap(url: string, limit: number): Promise<string[]> {
  const xml = await fetchText(url);
  const locs = parseSitemapLocs(xml);
  if (!/<sitemapindex[\s>]/i.test(xml)) return locs.slice(0, limit);

  const pages: string[] = [];
  for (const child of locs) {
    if (pages.length >= limit) break;
    pages.push(...parseSitemapLocs(await fetchText(child)));
  }
  return pages.slice(0, limit);
}

export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeXml(m[1]!));
}

/**
 * Group URLs by route shape, e.g. /products/123 and /products/456 -> /products/:id,
 * so a 5,000-page sitemap can be audited as a handful of templates.
 */
export function urlTemplate(url: string): string {
  const { pathname } = new URL(url);
  const segments = pathname.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
    if (/^[0-9a-f]{12,}$/i.test(seg)) return ':id';
    // Slugs that end in an id, e.g. blue-chair-1234
    if (/^[a-z0-9-]+-\d{3,}$/i.test(seg)) return ':slug';
    return seg;
  });
  return segments.join('/') || '/';
}

export function groupByTemplate(urls: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const url of urls) {
    const key = urlTemplate(url);
    groups.set(key, [...(groups.get(key) ?? []), url]);
  }
  return groups;
}

export function samplePerTemplate(urls: readonly string[], perTemplate: number): string[] {
  return [...groupByTemplate(urls).values()].flatMap((group) => group.slice(0, perTemplate));
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Could not fetch ${url}: HTTP ${res.status}`);
  return res.text();
}

function decodeXml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
