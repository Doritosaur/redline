import { describe, expect, it, vi } from 'vitest';
import { fetchFieldData } from '../src/crux.js';

// Shape of a real queryRecord response (abridged).
const record = {
  record: {
    key: { origin: 'https://shop.example' },
    metrics: {
      largest_contentful_paint: {
        histogram: [{ start: 0, end: 2500, density: 0.61 }, { start: 2500, end: 4000, density: 0.24 }, { start: 4000, density: 0.15 }],
        percentiles: { p75: 3120 },
      },
      cumulative_layout_shift: {
        histogram: [{ start: '0.00', end: '0.10', density: 0.9 }, { start: '0.10', end: '0.25', density: 0.06 }, { start: '0.25', density: 0.04 }],
        percentiles: { p75: '0.04' },
      },
      interaction_to_next_paint: { histogram: [], percentiles: { p75: 540 } },
      experimental_time_to_first_byte: { percentiles: { p75: 610 } },
    },
    collectionPeriod: { firstDate: { year: 2026, month: 9, day: 5 }, lastDate: { year: 2026, month: 10, day: 2 } },
  },
};

const respond = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

describe('fetchFieldData', () => {
  it('falls back from the URL to the origin when the page lacks traffic', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(respond(404)).mockResolvedValueOnce(respond(200, record));
    const data = await fetchFieldData('https://shop.example/products/1', { apiKey: 'k', fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ url: 'https://shop.example/products/1', formFactor: 'PHONE' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ origin: 'https://shop.example', formFactor: 'PHONE' });
    expect(data?.scope).toBe('origin');
    expect(data?.collectionPeriod).toBe('2026-09-05 to 2026-10-02');
  });

  it('parses p75s (including string CLS), ratings and distributions', async () => {
    const data = await fetchFieldData('https://shop.example/', { apiKey: 'k', preset: 'desktop', fetch: vi.fn<typeof fetch>().mockResolvedValue(respond(200, record)) });
    const byId = Object.fromEntries(data!.metrics.map((m) => [m.id, m]));
    expect(data?.formFactor).toBe('DESKTOP');
    expect(byId.lcp).toMatchObject({ p75: 3120, rating: 'needs-improvement', distribution: { good: 0.61, needsImprovement: 0.24, poor: 0.15 } });
    expect(byId.cls).toMatchObject({ p75: 0.04, rating: 'good' });
    expect(byId.inp).toMatchObject({ p75: 540, rating: 'poor' });
    expect(byId.ttfb).toMatchObject({ p75: 610, rating: 'good' });
  });

  it('returns undefined without calling the API for localhost or when no data exists', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(respond(404));
    expect(await fetchFieldData('http://localhost:3000/', { apiKey: 'k', fetch: fetchMock })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fetchFieldData('https://tiny.example/', { apiKey: 'k', fetch: fetchMock })).toBeUndefined();
  });

  it('surfaces API errors such as a bad key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(respond(400, { error: { message: 'API key not valid' } }));
    await expect(fetchFieldData('https://shop.example/', { apiKey: 'bad', fetch: fetchMock })).rejects.toThrow(/HTTP 400.*API key not valid/);
  });
});
