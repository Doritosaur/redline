/** Extra Chrome flags from `REDLINE_CHROME_FLAGS` (space-separated), e.g. `--no-sandbox` in containers and locked-down CI. */
export function chromeFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.REDLINE_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean);
}

/** Lighthouse's own log level: errors only, or everything with `REDLINE_DEBUG=1`. */
export function lighthouseLogLevel(env: NodeJS.ProcessEnv = process.env): 'error' | 'info' {
  return env.REDLINE_DEBUG ? 'info' : 'error';
}
