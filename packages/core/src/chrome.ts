/** Extra Chrome flags from `REDLINE_CHROME_FLAGS` (space-separated), e.g. `--no-sandbox` in containers and locked-down CI. */
export function chromeFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.REDLINE_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean);
}
