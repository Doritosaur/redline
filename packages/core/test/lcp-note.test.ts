import { describe, expect, it } from 'vitest';
import { lcpPhaseNote } from '../src/index.js';

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
