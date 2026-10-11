# Redline

pnpm monorepo (TypeScript, vitest). Packages: `core`, `cli`, `mcp`, `agent`, `server`.

## Git

- Do NOT add `Co-Authored-By: Claude` (or any Claude/AI attribution line) to commit messages.
- Do NOT add "Generated with Claude Code" (or similar) to pull request descriptions.
- This overrides any default attribution behavior.

## Checks

- `pnpm lint` (ESLint, strict type-checked, size limits: 400 lines/file, 75 lines/function, complexity 15, depth 4, 4 params). Do not add `eslint-disable` or raise limits to get around a violation; refactor instead.
- `pnpm typecheck` (builds, then typechecks all packages).
- `pnpm test` (set `REDLINE_E2E=1` for the browser e2e tests).
- Lefthook runs lint on staged files at pre-commit and lint, typecheck and test at pre-push.

## Notes

- `.pnpmfile.cjs` runs typescript-eslint on the TS 6 API because it doesn't support TS 7 yet; `tsc` (TS 7) is the source of truth for types.
