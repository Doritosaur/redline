import { afterEach, describe, expect, it, vi } from 'vitest';
import { withoutSourceMapNoise } from '../src/quiet.js';

describe('withoutSourceMapNoise', () => {
  const real = console.error;
  afterEach(() => { console.error = real; });

  it('drops third-party source-map warnings but keeps every other error', async () => {
    const spy = vi.fn();
    console.error = spy;
    await withoutSourceMapNoise(() => {
      console.error('https://unpkg.com/x.mjs.map mapping for column out of bounds: 1:208');
      console.error('https://unpkg.com/x.mjs.map mapping for last column out of bounds: 1:9');
      console.error('something real broke');
      return Promise.resolve();
    });
    expect(spy.mock.calls).toEqual([['something real broke']]);
  });

  it('restores console.error afterwards, even when the callback throws', async () => {
    const spy = vi.fn();
    console.error = spy;
    await expect(withoutSourceMapNoise(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(console.error).toBe(spy);
  });

  it('stays filtered until the last of several overlapping callers finishes', async () => {
    const spy = vi.fn();
    console.error = spy;
    let release!: () => void;
    const slow = withoutSourceMapNoise(() => new Promise<void>((r) => { release = r; }));
    await withoutSourceMapNoise(() => Promise.resolve());
    console.error('x mapping for line out of bounds: 3');
    expect(spy).not.toHaveBeenCalled();
    release();
    await slow;
    expect(console.error).toBe(spy);
  });
});
