import { describe, expect, it } from 'vitest';
import { compactUrl, describeLabel, lcpPhaseNote } from '../src/index.js';

const lcp = { phases: [{ ms: 2 }, { ms: 2256 }] };

describe('lcpPhaseNote', () => {
  it('explains a large gap between the traced phases and the throttled LCP', () => {
    const note = lcpPhaseNote(lcp, 29710);
    expect(note).toContain('2.26 s');
    expect(note).toContain('29.71 s');
  });

  it('stays quiet when the numbers roughly agree', () => {
    expect(lcpPhaseNote(lcp, 3000)).toBeUndefined();
  });

  it('stays quiet without an LCP element, phases or metric', () => {
    expect(lcpPhaseNote(undefined, 5000)).toBeUndefined();
    expect(lcpPhaseNote({ phases: [] }, 5000)).toBeUndefined();
    expect(lcpPhaseNote(lcp, undefined)).toBeUndefined();
  });
});

describe('compactUrl and describeLabel', () => {
  it('drops long query strings and cuts overlong paths', () => {
    expect(compactUrl('https://a.com/x.js?v=1')).toBe('/x.js?v=1');
    expect(compactUrl(`https://a.com/signals/config/1?${'x=1&'.repeat(100)}`)).toBe('/signals/config/1?…');
    expect(compactUrl(`https://a.com/${'p'.repeat(200)}`)).toHaveLength(90);
  });

  it('explains Lighthouse\'s Unattributable row and leaves other labels alone', () => {
    expect(describeLabel('Unattributable')).toContain('not tied to any script URL');
    expect(describeLabel('Other')).toBe('Other');
    expect(describeLabel(undefined)).toBeUndefined();
  });
});
