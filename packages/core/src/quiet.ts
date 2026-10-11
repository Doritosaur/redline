/**
 * Lighthouse's trace engine reports unusable third-party source maps with a bare `console.error`
 * (bypassing Lighthouse's logger), once per run, on any page that loads such a bundle. The audit is
 * unaffected and users can't act on it, so drop exactly those lines while a run is in flight.
 */
const SOURCE_MAP_NOISE = /mapping for (?:last )?(?:line|column) out of bounds/;

let active = 0;
let original: typeof console.error | undefined;

function install(): void {
  original = console.error;
  const passthrough = original;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && SOURCE_MAP_NOISE.test(args[0])) return;
    passthrough(...args);
  };
}

/** Run `fn` with source-map noise filtered. Safe to nest or overlap: console.error is restored when the last caller finishes. */
export async function withoutSourceMapNoise<T>(fn: () => Promise<T>): Promise<T> {
  if (active++ === 0) install();
  try {
    return await fn();
  } finally {
    if (--active === 0 && original) {
      console.error = original;
      original = undefined;
    }
  }
}
