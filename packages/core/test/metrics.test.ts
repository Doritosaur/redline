import { describe, expect, it } from 'vitest';
import { median, rate } from '../src/metrics.js';

describe('rate', () => {
  it('uses inclusive upper bounds for each band', () => {
    expect(rate('lcp', 2500)).toBe('good');
    expect(rate('lcp', 2501)).toBe('needs-improvement');
    expect(rate('lcp', 4000)).toBe('needs-improvement');
    expect(rate('lcp', 4001)).toBe('poor');
  });

  it('rates unitless CLS', () => {
    expect(rate('cls', 0.05)).toBe('good');
    expect(rate('cls', 0.2)).toBe('needs-improvement');
    expect(rate('cls', 0.3)).toBe('poor');
  });
});

describe('median', () => {
  it('handles odd and even counts without mutating input', () => {
    const values = [300, 100, 200];
    expect(median(values)).toBe(200);
    expect(values).toEqual([300, 100, 200]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('rejects an empty list', () => {
    expect(() => median([])).toThrow();
  });
});
