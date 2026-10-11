/** Extra Chrome flags from `REDLINE_CHROME_FLAGS` (space-separated), e.g. `--no-sandbox` in containers and locked-down CI. */
export function chromeFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.REDLINE_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Lighthouse's own log level. Lighthouse logs unusable third-party source maps at `error`, which is noise
 * the user can't act on; real failures still surface as thrown errors. Set `REDLINE_DEBUG=1` to see everything.
 */
export function lighthouseLogLevel(env: NodeJS.ProcessEnv = process.env): 'silent' | 'info' {
  return env.REDLINE_DEBUG ? 'info' : 'silent';
}
