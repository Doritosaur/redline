import fs from 'node:fs';
import path from 'node:path';

export interface CompatIssue {
  /** Path relative to the scanned root. */
  file: string;
  line: number;
  column: number;
  kind: 'js' | 'css';
  /** Feature name, e.g. `structuredClone`, `css-has`. */
  feature: string;
  message: string;
}

export interface CompatReport {
  root: string;
  /** Resolved browserslist targets, e.g. ["safari 14", "firefox 90"]. */
  targets: string[];
  /** Where the targets came from: "browserslist config", "option" or "browserslist defaults". */
  targetsSource: string;
  filesScanned: number;
  issues: CompatIssue[];
  /** Files that could not be parsed, with the reason. */
  skipped: { file: string; reason: string }[];
}

export interface CompatOptions {
  /** Browserslist queries; defaults to the project's browserslist config. */
  browsers?: string[];
  /** APIs the project polyfills, e.g. ["fetch", "Promise.allSettled"] (eslint-plugin-compat syntax). */
  polyfills?: string[];
  /** Directories to skip, in addition to node_modules and common build output. */
  ignore?: string[];
  /** Stop after scanning this many files. Default 2000. */
  maxFiles?: number;
}

const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const CSS_EXTENSIONS = new Set(['.css', '.scss']);
const DEFAULT_IGNORE = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', '.output', '.git', '.redline', 'vendor']);

/**
 * Statically check project source for JS APIs and CSS features the target browsers don't support.
 * TypeScript/JSX is transformed with esbuild first, and findings are mapped back to the original lines.
 */
export async function checkCompat(root: string, options: CompatOptions = {}): Promise<CompatReport> {
  const browserslist = (await import('browserslist')).default;
  const absRoot = path.resolve(root);
  const configured = options.browsers ?? browserslist.loadConfig({ path: absRoot });
  const queries = [...(configured ?? browserslist.defaults)];
  const targets = browserslist(queries, { path: absRoot });

  const ignore = new Set([...DEFAULT_IGNORE, ...(options.ignore ?? [])]);
  const files = listFiles(absRoot, ignore, options.maxFiles ?? 2000);
  const report: CompatReport = {
    root: absRoot,
    targets,
    targetsSource: options.browsers ? 'option' : configured ? 'browserslist config' : 'browserslist defaults',
    filesScanned: files.length,
    issues: [],
    skipped: [],
  };

  const js = files.filter((f) => JS_EXTENSIONS.has(path.extname(f)));
  const css = files.filter((f) => CSS_EXTENSIONS.has(path.extname(f)));
  if (js.length) await checkJs({ files: js, root: absRoot, queries, polyfills: options.polyfills ?? [], report });
  if (css.length) await checkCss(css, absRoot, queries, report);
  report.issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return report;
}

interface CheckJsOptions {
  files: string[];
  root: string;
  queries: string[];
  polyfills: string[];
  report: CompatReport;
}

async function checkJs({ files, root, queries, polyfills, report }: CheckJsOptions) {
  const [{ Linter }, compat, esbuild, { SourceMapConsumer }] = await Promise.all([
    import('eslint'),
    import('eslint-plugin-compat'),
    import('esbuild'),
    import('source-map-js'),
  ]);
  // Flat config matches `files` globs relative to cwd; anchor it at the scanned root so projects outside the cwd are linted too.
  const linter = new Linter({ configType: 'flat', cwd: root });
  const config = [
    {
      // Flat config only lints .js by default; TS files are linted as their transformed .jsx output.
      files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
      plugins: { compat: compat.default },
      rules: { 'compat/compat': 'error' as const },
      settings: { browsers: queries, polyfills, lintAllEsApis: true },
      languageOptions: { ecmaVersion: 'latest' as const, sourceType: 'module' as const, parserOptions: { ecmaFeatures: { jsx: true } } },
    },
  ];

  for (const file of files) {
    const rel = toPosix(path.relative(root, file));
    const source = fs.readFileSync(file, 'utf8');
    let code = source;
    let map: InstanceType<typeof SourceMapConsumer> | undefined;
    if (/\.[mc]?tsx?$/.test(file)) {
      try {
        const out = await esbuild.transform(source, {
          loader: file.endsWith('x') ? 'tsx' : 'ts',
          jsx: 'preserve',
          target: 'esnext',
          sourcemap: 'external',
          sourcefile: rel,
        });
        code = out.code;
        map = new SourceMapConsumer(JSON.parse(out.map) as ConstructorParameters<typeof SourceMapConsumer>[0]);
      } catch (err) {
        report.skipped.push({ file: rel, reason: firstLine(err) });
        continue;
      }
    }
    // `.js` files may use JSX too; the parser accepts it either way.
    const messages = linter.verify(code, config, { filename: path.join(root, rel.replace(/\.[mc]?tsx?$/, '.jsx')) });
    for (const m of messages) {
      // Parse errors and config-level messages (line 0) mean the file wasn't checked, not that it has an issue.
      if (m.fatal || m.line < 1) {
        report.skipped.push({ file: rel, reason: m.message });
        continue;
      }
      const pos = map && m.line >= 1 ? map.originalPositionFor({ line: m.line, column: Math.max(0, m.column - 1) }) : undefined;
      report.issues.push({
        file: rel,
        line: pos?.line ?? m.line,
        column: typeof pos?.column === 'number' ? pos.column + 1 : m.column,
        kind: 'js',
        feature: featureFromMessage(m.message),
        message: m.message,
      });
    }
  }
}

async function checkCss(files: string[], root: string, queries: string[], report: CompatReport) {
  const [{ default: postcss }, { default: doiuse }, { default: scss }] = await Promise.all([
    import('postcss'),
    import('doiuse'),
    import('postcss-scss'),
  ]);
  for (const file of files) {
    const rel = toPosix(path.relative(root, file));
    const found: CompatIssue[] = [];
    const plugin = doiuse({
      browsers: queries,
      onFeatureUsage: (usage: { feature: string; message: string; usage: { source?: { start?: { line: number; column: number } } } }) => {
        const start = usage.usage.source?.start;
        found.push({
          file: rel,
          line: start?.line ?? 0,
          column: start?.column ?? 0,
          kind: 'css',
          feature: usage.feature,
          // doiuse prefixes messages with "<file>:<line>:<col>: "; the location is already in the issue.
          message: usage.message.replace(/^.*?:\d+:\d+:\s*/, ''),
        });
      },
    });
    try {
      await postcss([plugin]).process(fs.readFileSync(file, 'utf8'), {
        from: file,
        ...(file.endsWith('.scss') ? { syntax: scss } : {}),
      });
      report.issues.push(...found);
    } catch (err) {
      report.skipped.push({ file: rel, reason: firstLine(err) });
    }
  }
}

function listFiles(root: string, ignore: Set<string>, max: number): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= max) return;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) walk(full);
      } else if (JS_EXTENSIONS.has(path.extname(entry.name)) || CSS_EXTENSIONS.has(path.extname(entry.name))) {
        if (!/\.(min|d)\.[a-z]+$/.test(entry.name) && !/\.(test|spec|config)\.[a-z]+$/.test(entry.name)) out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** "structuredClone() is not supported in Safari 14" -> "structuredClone" */
function featureFromMessage(message: string): string {
  return message.split(' is not supported')[0]?.replace(/\(\)$/, '') ?? message;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'unknown error';
}
