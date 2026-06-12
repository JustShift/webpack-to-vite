#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { analyzeWebpackConfig } from './converter.js';
import { getConfidence, tierCounts } from './confidence.js';
import type { ConversionResult } from './types.js';

const args = process.argv.slice(2);

const showHelp = () => {
  process.stdout.write(`@shiftkit/webpack-to-vite

Analyze a Webpack config and emit a Vite config skeleton + a migration report.
Static AST analysis only — your webpack config is never executed.

Usage:
  webpack-to-vite [options] [file]
  cat webpack.config.js | webpack-to-vite
  webpack-to-vite webpack.config.js --apply --out vite.config.ts

Options:
      --json              Emit { output, warnings, flags, dependencies } as JSON
  -s, --strict            Exit non-zero if any 'manual' warnings are emitted
      --target-vite <n>   Target Vite major: 8 (default) or 7
      --source <glob>     Also scan source files for migration traps (advanced)
      --apply             Write the Vite config + a JSON report to disk
      --out <file>        With --apply, the config path (default vite.config.ts)
      --deps              With --apply, add the REQUIRED dependencies from the
                          checklist to package.json devDependencies (opt-in;
                          nothing is ever removed)
      --force             With --apply, bypass dirty-tree / overwrite / repo checks
  -q, --quiet             Suppress the report on stderr
  -h, --help              Show this help

Default (no --apply): writes the Vite config skeleton to stdout; the migration
report goes to stderr. --apply also writes shiftkit-webpack-to-vite-report.json
and, when HtmlWebpackPlugin was detected, an index.html skeleton (only if none
exists). It never deletes your webpack config and never touches package.json
unless you opt in with --deps.
`);
};

interface ParsedArgs {
  strict: boolean;
  quiet: boolean;
  json: boolean;
  apply: boolean;
  deps: boolean;
  force: boolean;
  out: string;
  targetVite: 7 | 8;
  sources: string[];
  file: string | null;
}

const parseArgs = (): ParsedArgs => {
  const p: ParsedArgs = {
    strict: false,
    quiet: false,
    json: false,
    apply: false,
    deps: false,
    force: false,
    out: 'vite.config.ts',
    targetVite: 8,
    sources: [],
    file: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      showHelp();
      process.exit(0);
    } else if (a === '-s' || a === '--strict') p.strict = true;
    else if (a === '-q' || a === '--quiet') p.quiet = true;
    else if (a === '--json') p.json = true;
    else if (a === '--apply' || a === '--write') p.apply = true;
    else if (a === '--deps') p.deps = true;
    else if (a === '--force') p.force = true;
    else if (a === '--out') p.out = args[++i] ?? p.out;
    else if (a === '--source') p.sources.push(args[++i] ?? '');
    else if (a === '--target-vite') {
      const n = args[++i];
      if (n !== '7' && n !== '8') {
        process.stderr.write(`Invalid --target-vite '${n}'. Use 7 or 8.\n`);
        process.exit(2);
      }
      p.targetVite = n === '7' ? 7 : 8;
    } else if (!a.startsWith('-') && p.file === null) p.file = a;
    else {
      process.stderr.write(`Unknown argument: ${a}\nRun with --help for usage.\n`);
      process.exit(2);
    }
  }
  return p;
};

const readStdin = (): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });

const WEBPACK_FILES = [
  'webpack.config.js',
  'webpack.config.cjs',
  'webpack.config.mjs',
  'webpack.config.ts',
  'webpack.prod.js',
  'webpack.common.js',
] as const;

const findWebpackConfig = (cwd: string): string | null => {
  for (const f of WEBPACK_FILES) {
    const candidate = join(cwd, f);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const checkGit = (): { isRepo: boolean; isDirty: boolean } => {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  } catch {
    return { isRepo: false, isDirty: false };
  }
  try {
    const out = execSync('git status --porcelain', { encoding: 'utf8' });
    return { isRepo: true, isDirty: out.trim().length > 0 };
  } catch {
    return { isRepo: true, isDirty: false };
  }
};

// ---- minimal, dependency-free glob for --source ----

const expandBraces = (pattern: string): string[] => {
  const m = pattern.match(/\{([^{}]*)\}/);
  if (!m) return [pattern];
  const [full, inner] = m;
  return inner!.split(',').flatMap((opt) => expandBraces(pattern.replace(full!, opt)));
};

const globToRegExp = (glob: string): RegExp => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
};

const staticBase = (glob: string): string => {
  const idx = glob.search(/[*?{]/);
  if (idx === -1) return dirname(glob);
  const prefix = glob.slice(0, idx);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '.' : prefix.slice(0, slash);
};

const walkFiles = (dir: string, out: string[]): void => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
};

const collectSources = (globs: string[], cwd: string): Array<{ path: string; content: string }> => {
  const files = new Map<string, string>();
  for (const raw of globs) {
    for (const pattern of expandBraces(raw)) {
      const base = join(cwd, staticBase(pattern));
      const re = globToRegExp(pattern);
      const candidates: string[] = [];
      walkFiles(base, candidates);
      for (const abs of candidates) {
        const rel = relative(cwd, abs).split('\\').join('/');
        if (re.test(rel) && !files.has(abs)) {
          try {
            files.set(abs, readFileSync(abs, 'utf8'));
          } catch {
            /* ignore unreadable */
          }
        }
      }
    }
  }
  return [...files.entries()].map(([path, content]) => ({ path: relative(cwd, path).split('\\').join('/'), content }));
};

// ---- --deps: opt-in package.json devDependencies update ----

// Default version ranges for newly-added devDependencies. Reviewed 2026-06;
// bump these when the Vite ecosystem ships new majors (see RELEASING.md).
const DEP_VERSION_RANGES: Record<string, string> = {
  vite: '^8.0.0',
  'vite-plugin-svgr': '^5.0.0',
  sass: '^1.80.0',
  less: '^4.2.0',
  stylus: '^0.64.0',
  'vite-tsconfig-paths': '^6.0.0',
  'vite-plugin-static-copy': '^3.0.0',
  'vite-plugin-checker': '^0.11.0',
  'rollup-plugin-visualizer': '^6.0.0',
  'vite-plugin-compression2': '^2.0.0',
  'vite-plugin-node-polyfills': '^0.24.0',
  '@vitejs/plugin-react': '^5.0.0',
  '@vitejs/plugin-vue': '^6.0.0',
  '@sveltejs/vite-plugin-svelte': '^6.0.0',
  'vite-plugin-solid': '^2.11.0',
  '@vitejs/plugin-basic-ssl': '^2.0.0',
};

// Adds the *required* checklist dependencies to devDependencies. Deliberately
// additive-only: the analyzer cannot know which webpack packages are still
// needed (multi-config repos, scripts), so it never removes anything.
const addRequiredDeps = (pkgPath: string, result: ConversionResult, targetVite: 7 | 8): string[] => {
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.devDependencies = pkg.devDependencies ?? {};
  const added: string[] = [];
  for (const dep of result.dependencies) {
    if (!dep.required) continue;
    if (pkg.dependencies?.[dep.name] || pkg.devDependencies[dep.name]) continue;
    let range = DEP_VERSION_RANGES[dep.name] ?? 'latest';
    if (dep.name === 'vite' && targetVite === 7) range = '^7.0.0';
    pkg.devDependencies[dep.name] = range;
    added.push(dep.name);
  }
  if (added.length > 0) {
    const trailingNewline = raw.endsWith('\n') ? '\n' : '';
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + trailingNewline);
  }
  return added;
};

// ---- output ----

const printReport = (result: ConversionResult, quiet: boolean): void => {
  if (quiet) return;
  const { warnings, dependencies } = result;
  process.stderr.write(`\n${getConfidence(warnings)} — ${tierCounts(warnings)}\n`);
  if (warnings.length > 0) {
    process.stderr.write(`\nMigration report:\n`);
    for (const w of warnings) process.stderr.write(`  [${w.type}] (${w.code}) ${w.message}${w.path ? ` — ${w.path}` : ''}\n`);
  }
  if (dependencies.length > 0) {
    process.stderr.write(`\nDependencies:\n`);
    for (const d of dependencies) {
      process.stderr.write(`  ${d.required ? '(required)' : '(optional)'} ${d.name} — ${d.reason}${d.caution ? ` [${d.caution}]` : ''}\n`);
    }
  }
};

const main = async () => {
  const parsed = parseArgs();
  const cwd = process.cwd();

  if (parsed.apply) {
    const src = parsed.file ? resolve(cwd, parsed.file) : findWebpackConfig(cwd);
    if (!src || !existsSync(src)) {
      process.stderr.write(`--apply: no webpack config found${parsed.file ? ` at ${parsed.file}` : ` in ${cwd}`}.\n`);
      process.exit(1);
    }
    const git = checkGit();
    if (git.isDirty && !parsed.force) {
      process.stderr.write(`--apply: working tree is dirty. Commit or stash first, or re-run with --force.\n`);
      process.exit(1);
    }
    if (!git.isRepo && !parsed.force) {
      process.stderr.write(`--apply: ${cwd} is not a git repository. Re-run with --force to apply without a rollback path.\n`);
      process.exit(1);
    }
    const target = resolve(cwd, parsed.out);
    if (existsSync(target) && !parsed.force) {
      process.stderr.write(`Refusing to overwrite existing ${parsed.out}. Re-run with --force.\n`);
      process.exit(1);
    }

    const sources = parsed.sources.length > 0 ? collectSources(parsed.sources, cwd) : [];
    const result = analyzeWebpackConfig(readFileSync(src, 'utf8'), {
      strict: parsed.strict,
      targetViteMajor: parsed.targetVite,
      sourceFiles: sources,
    });

    if (parsed.strict && result.warnings.some((w) => w.type === 'manual')) {
      process.stderr.write(`--apply --strict: manual warning(s) present; aborting before write.\n`);
      printReport(result, parsed.quiet);
      process.exit(1);
    }

    writeFileSync(target, result.output.endsWith('\n') ? result.output : `${result.output}\n`);
    const reportPath = join(cwd, 'shiftkit-webpack-to-vite-report.json');
    writeFileSync(reportPath, JSON.stringify(result, null, 2) + '\n');

    let wroteIndexHtml: string | null = null;
    let skippedIndexHtml = false;
    if (result.indexHtml) {
      const indexPath = join(cwd, 'index.html');
      if (existsSync(indexPath)) {
        skippedIndexHtml = true;
      } else {
        writeFileSync(indexPath, result.indexHtml);
        wroteIndexHtml = indexPath;
      }
    }

    let depsAdded: string[] = [];
    if (parsed.deps) {
      const pkgPath = join(cwd, 'package.json');
      if (existsSync(pkgPath)) {
        depsAdded = addRequiredDeps(pkgPath, result, parsed.targetVite);
      } else {
        process.stderr.write(`--deps: no package.json found in ${cwd}; skipped.\n`);
      }
    }

    if (parsed.json) {
      process.stdout.write(
        JSON.stringify(
          { wrote: target, report: reportPath, indexHtml: wroteIndexHtml, depsAdded, ...result },
          null,
          2
        ) + '\n'
      );
    } else {
      process.stdout.write(`✓ Wrote ${parsed.out} (a skeleton — review the report).\n`);
      process.stdout.write(`✓ Wrote shiftkit-webpack-to-vite-report.json\n`);
      if (wroteIndexHtml) {
        process.stdout.write(`✓ Wrote index.html (skeleton from HtmlWebpackPlugin — merge your template markup).\n`);
      } else if (skippedIndexHtml) {
        process.stdout.write(`• index.html already exists; the generated skeleton is in the JSON report (indexHtml).\n`);
      }
      if (depsAdded.length > 0) {
        process.stdout.write(`✓ Added to package.json devDependencies: ${depsAdded.join(', ')}\n`);
      } else if (parsed.deps) {
        process.stdout.write(`• --deps: all required dependencies are already present.\n`);
      }
      printReport(result, parsed.quiet);
    }
    return;
  }

  const input = parsed.file ? readFileSync(resolve(cwd, parsed.file), 'utf8') : await readStdin();
  if (!input.trim()) {
    process.stderr.write('No input provided. Pass a file path or pipe via stdin (or use --apply).\n');
    process.exit(2);
  }
  const sources = parsed.sources.length > 0 ? collectSources(parsed.sources, cwd) : [];
  const result = analyzeWebpackConfig(input, {
    strict: parsed.strict,
    targetViteMajor: parsed.targetVite,
    sourceFiles: sources,
  });

  if (parsed.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(result.output + '\n');
    printReport(result, parsed.quiet);
  }

  if (parsed.strict && result.warnings.some((w) => w.type === 'manual')) process.exit(1);
};

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
