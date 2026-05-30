#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { analyzeWebpackConfig, type ConversionResult } from './converter.js';

const args = process.argv.slice(2);

const showHelp = () => {
  process.stdout.write(`@shiftkit/webpack-to-vite

Analyze a Webpack config and emit a Vite config skeleton + a migration report.

Usage:
  webpack-to-vite [options] [file]
  cat webpack.config.js | webpack-to-vite
  webpack-to-vite --apply

Options:
  -s, --strict   Exit non-zero if any 'manual' warnings are emitted
  -q, --quiet    Suppress warnings on stderr
      --json     Emit { output, warnings, flags } as JSON to stdout
      --apply    Write vite.config.ts to disk (auto-detects webpack.config.*)
      --force    With --apply, bypass dirty-tree / overwrite / not-a-repo checks
  -h, --help     Show this help

Default (no --apply): reads the input file (or stdin) and writes the Vite config
skeleton to stdout; the migration report goes to stderr.
`);
};

interface ParsedArgs {
  strict: boolean;
  quiet: boolean;
  json: boolean;
  apply: boolean;
  force: boolean;
  file: string | null;
}

const parseArgs = (): ParsedArgs => {
  const p: ParsedArgs = { strict: false, quiet: false, json: false, apply: false, force: false, file: null };
  for (const a of args) {
    if (a === '-h' || a === '--help') { showHelp(); process.exit(0); }
    else if (a === '-s' || a === '--strict') p.strict = true;
    else if (a === '-q' || a === '--quiet') p.quiet = true;
    else if (a === '--json') p.json = true;
    else if (a === '--apply' || a === '--write') p.apply = true;
    else if (a === '--force') p.force = true;
    else if (!a.startsWith('-') && p.file === null) p.file = a;
    else { process.stderr.write(`Unknown argument: ${a}\nRun with --help for usage.\n`); process.exit(2); }
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
    const p = join(cwd, f);
    if (existsSync(p)) return p;
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

const emit = (result: ConversionResult, parsed: ParsedArgs, toStdout: boolean) => {
  if (parsed.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (toStdout) process.stdout.write(result.output + '\n');
  if (!parsed.quiet && result.warnings.length > 0) {
    process.stderr.write(`\n${result.warnings.length} item(s) in the migration report:\n`);
    for (const w of result.warnings) process.stderr.write(`  [${w.type}] ${w.message}\n`);
  }
};

const main = async () => {
  const parsed = parseArgs();

  if (parsed.apply) {
    const cwd = process.cwd();
    const src = findWebpackConfig(cwd);
    if (!src) {
      process.stderr.write(`--apply: no webpack.config.* found in ${cwd}.\n`);
      process.exit(1);
    }
    const git = checkGit();
    if (git.isDirty && !parsed.force) {
      process.stderr.write(`--apply: working tree is dirty. Commit or stash first, or re-run with --force.\n`);
      process.exit(1);
    }
    const target = join(cwd, 'vite.config.ts');
    if (existsSync(target) && !parsed.force) {
      process.stderr.write(`Refusing to overwrite existing vite.config.ts. Re-run with --force.\n`);
      process.exit(1);
    }
    const result = analyzeWebpackConfig(readFileSync(src, 'utf8'));
    if (parsed.strict && result.warnings.some((w) => w.type === 'manual')) {
      process.stderr.write(`--apply --strict: manual warning(s) present; aborting before write.\n`);
      emit(result, parsed, false);
      process.exit(1);
    }
    writeFileSync(target, result.output.endsWith('\n') ? result.output : `${result.output}\n`);
    if (!parsed.json) process.stdout.write(`✓ Wrote ${target} (a skeleton — review the migration report).\n`);
    emit(result, parsed, false);
    return;
  }

  const input = parsed.file ? readFileSync(parsed.file, 'utf8') : await readStdin();
  if (!input.trim()) {
    process.stderr.write('No input provided. Pass a file path or pipe via stdin (or use --apply).\n');
    process.exit(2);
  }
  const result = analyzeWebpackConfig(input);
  emit(result, parsed, true);
  if (parsed.strict && result.warnings.some((w) => w.type === 'manual')) process.exit(1);
};

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
