/**
 * @shiftkit/webpack-to-vite — Webpack → Vite migration analyzer.
 *
 * analyzeWebpackConfig() parses a webpack config statically (Babel AST, never
 * executed) and returns a Vite-8-oriented vite.config.ts skeleton, a tiered
 * migration report (manual / verify / info), the detection flags, and a
 * dependency checklist.
 *
 *   auto   — statically safe config mapping
 *   verify — mapped or suggested, but behavior may differ
 *   manual — cannot be safely mapped from config alone
 *   info   — bookkeeping / dropped because Vite handles it
 */
import * as t from '@babel/types';
import { parseWebpackConfig } from './parser.js';
import { propName } from './static-eval.js';
import { render } from './render.js';
import { buildDependencies } from './dependencies.js';
import {
  handleDevServer,
  handleDevtool,
  handleEntry,
  handleExternals,
  handleModule,
  handleOptimization,
  handleOutput,
  handlePlugins,
  handleResolve,
  handleTarget,
  scanSource,
} from './handlers.js';
import {
  DEFAULT_TARGET_VITE_MAJOR,
  emptyFlags,
  emptyModel,
  type AnalyzeOptions,
  type AnalyzerContext,
  type ConversionFlags,
  type ConversionResult,
  type ResolvedOptions,
  type Warning,
  type WarningCode,
} from './types.js';

function resolveOptions(options?: AnalyzeOptions): ResolvedOptions {
  return {
    strict: options?.strict ?? false,
    targetViteMajor: options?.targetViteMajor ?? DEFAULT_TARGET_VITE_MAJOR,
    sourceFiles: options?.sourceFiles ?? [],
  };
}

function createContext(options: ResolvedOptions): { ctx: AnalyzerContext; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const seen = new Set<string>();
  const warn = (type: Warning['type'], code: WarningCode, message: string, path?: string) => {
    const key = `${type}:${code}:${message}:${path ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push(path ? { type, code, message, path } : { type, code, message });
  };
  const ctx: AnalyzerContext = {
    model: emptyModel(),
    flags: emptyFlags(options.targetViteMajor),
    options,
    extraDependencies: [],
    manual: (code, message, path) => warn('manual', code, message, path),
    verify: (code, message, path) => warn('verify', code, message, path),
    info: (code, message, path) => warn('info', code, message, path),
  };
  return { ctx, warnings };
}

function failure(message: string, code: WarningCode, output: string, flags: ConversionFlags): ConversionResult {
  return {
    output,
    warnings: [{ type: 'manual', code, message }],
    flags,
    dependencies: buildDependencies(flags),
  };
}

export function analyzeWebpackConfig(input: string, options?: AnalyzeOptions): ConversionResult {
  const resolved = resolveOptions(options);
  const flags = emptyFlags(resolved.targetViteMajor);

  const parsed = parseWebpackConfig(input);
  if (parsed.parseError) {
    return failure(
      'Failed to parse the input as JavaScript/TypeScript. Ensure it is a valid webpack config.',
      'config.parseError',
      `// Failed to parse webpack config as JavaScript/TypeScript.\n// Error: ${parsed.parseError}\n\n${input}`,
      flags
    );
  }
  if (!parsed.configObject) {
    return failure(
      'Could not detect a webpack config object (module.exports = {…}, export default {…}, or a function returning one).',
      'config.notFound',
      `// Could not find a webpack config object.\n` +
        `// Expected module.exports = {...}, export default {...}, a config identifier,\n` +
        `// or a function returning a static config object.\n\n${input}`,
      flags
    );
  }

  const { ctx, warnings } = createContext(resolved);

  // Input-shape notes.
  if (parsed.usedFunctionForm) {
    ctx.verify(
      'config.functionForm',
      `A function-form config (e.g. module.exports = (env, argv) => ({...})) was detected. The returned static object was read WITHOUT executing the function; any logic in the body was not evaluated.`
    );
  }
  if (parsed.dependsOnEnvArgv) {
    ctx.manual(
      'config.dynamic',
      `Config depends on env/argv. This analyzer parsed the static shape only — resolve the conditional config (per-mode values) manually.`
    );
  }
  if (parsed.multiConfigArray) {
    ctx.verify(
      'config.multiConfig',
      `Multiple configs were exported as an array. Only the first config was analyzed; migrate the others separately (Vite multi-build needs separate configs or a build script).`
    );
  }

  // Cheap framework detection from the raw config text.
  if (/react-scripts/.test(input)) {
    ctx.flags.hasFrameworkSpecificWebpack = true;
    ctx.info(
      'framework.cra',
      `Create React App (react-scripts) signals detected. CRA hides its webpack config; consider the CRA → Vite path (index.html move, env vars REACT_APP_* → VITE_*, jest → vitest) rather than migrating an ejected config field-by-field.`
    );
  }

  // webpack-merge means we likely only see one of several merged config layers.
  if (/webpack-merge/.test(input)) {
    ctx.verify(
      'config.merge',
      `webpack-merge detected. The analyzer reads one config object statically — if your real config is the merge of several files, resolve the merged result first (or run the analyzer per file) so nothing is missed.`
    );
  }

  // Suggest (and wire in) the matching Vite framework plugin — a React/Vue/etc.
  // Vite config without its framework plugin won't render components.
  detectFrameworkPlugin(ctx, input);

  // TypeScript path coupling → enable Vite's tsconfig paths resolution.
  if (/tsconfig-?paths/i.test(input)) {
    ctx.flags.needsTsconfigPaths = true;
    ctx.model.resolve.tsconfigPaths = true;
    ctx.verify(
      'resolve.tsconfigPaths',
      resolved.targetViteMajor === 8
        ? `tsconfig path coupling detected. Enabled Vite 8's built-in resolve.tsconfigPaths: true (note: it has a small resolution-performance cost).`
        : `tsconfig path coupling detected. Added the vite-tsconfig-paths plugin (Vite 7 has no built-in tsconfig paths resolution).`
    );
  }

  dispatch(ctx, parsed.configObject);

  // Optional, opt-in source scan (CLI / advanced browser input).
  if (resolved.sourceFiles.length > 0) {
    scanSource(ctx, resolved.sourceFiles);
  }

  // Vite 8 bookkeeping note: emitted when Vite-8-sensitive build output appears.
  const b = ctx.model.build;
  if (
    resolved.targetViteMajor === 8 &&
    (b.input != null || b.entryFileNames != null || b.chunkFileNames != null || b.codeSplittingNote === true || ctx.flags.hasExternals)
  ) {
    ctx.model.vite8NoteNeeded = true;
    ctx.info(
      'vite8.note',
      `Output targets Vite 8: build.rollupOptions → build.rolldownOptions, build.commonjsOptions is a no-op, and object-form manualChunks was removed (use Rolldown codeSplitting).`
    );
  }

  const output = render(ctx.model, resolved.targetViteMajor);
  return {
    output,
    warnings,
    flags: ctx.flags,
    dependencies: mergeDependencies(buildDependencies(ctx.flags), ctx.extraDependencies),
  };
}

function mergeDependencies(
  base: ConversionResult['dependencies'],
  extra: ConversionResult['dependencies']
): ConversionResult['dependencies'] {
  const seen = new Set(base.map((d) => d.name));
  return [...base, ...extra.filter((d) => !seen.has(d.name))];
}

// Detect the source framework and wire in the matching Vite plugin + dependency.
// Conservative: only fires on strong signals (loader/preset/runtime package names),
// and React is checked last so explicit vue/svelte/solid configs win.
function detectFrameworkPlugin(ctx: AnalyzerContext, input: string): void {
  const add = (
    pluginImport: string,
    pluginCall: string,
    depName: string,
    label: string
  ): void => {
    ctx.model.imports.add(pluginImport);
    if (!ctx.model.plugins.includes(pluginCall)) ctx.model.plugins.unshift(pluginCall);
    ctx.extraDependencies.push({
      name: depName,
      reason: `Vite needs the ${label} plugin to compile ${label} components (webpack used a loader/preset for this).`,
      required: true,
    });
    ctx.verify(
      'framework.plugin',
      `${label} signals detected — added the ${depName} plugin to the Vite config. Verify it is the right framework plugin and version for your app.`
    );
  };

  if (/vue-loader|@vitejs\/plugin-vue|['"]vue['"]/.test(input)) {
    add(`import vue from '@vitejs/plugin-vue';`, 'vue()', '@vitejs/plugin-vue', 'Vue');
    return;
  }
  if (/svelte-loader|svelte-preprocess|['"]svelte['"]/.test(input)) {
    add(
      `import { svelte } from '@sveltejs/vite-plugin-svelte';`,
      'svelte()',
      '@sveltejs/vite-plugin-svelte',
      'Svelte'
    );
    return;
  }
  if (/solid-js|babel-preset-solid|vite-plugin-solid/.test(input)) {
    add(`import solid from 'vite-plugin-solid';`, 'solid()', 'vite-plugin-solid', 'Solid');
    return;
  }
  if (/react-dom|preset-react|@svgr\/webpack|react-scripts|@vitejs\/plugin-react/.test(input)) {
    add(`import react from '@vitejs/plugin-react';`, 'react()', '@vitejs/plugin-react', 'React');
  }
}

// Top-level webpack fields whose closest Vite behavior is "drop it / handled
// automatically". Emitting info keeps the report honest without noise.
const BENIGN_TOP_LEVEL = new Set([
  'context',
  'stats',
  'performance',
  'cache',
  'watch',
  'watchOptions',
  'infrastructureLogging',
  'experiments',
  'node',
  'snapshot',
  'recordsPath',
  'profile',
  'parallelism',
  'name',
  'dependencies',
  'resolveLoader',
  'ignoreWarnings',
  'amd',
  'bail',
  'loader',
]);

// A section value the analyzer cannot read must still surface in the report —
// silence here would print "High confidence" over dropped config.
function dynamicSection(ctx: AnalyzerContext, key: string): void {
  ctx.manual(
    'config.dynamic',
    `'${key}' is not a static literal and could not be analyzed. Inline its value and re-run, or migrate the section manually.`
  );
}

function unwrapObject(node: t.Node): t.ObjectExpression | null {
  if (t.isObjectExpression(node)) return node;
  if (t.isTSAsExpression(node) || t.isTSSatisfiesExpression(node)) return unwrapObject(node.expression);
  return null;
}

// Resolve conditional-inclusion idioms around the plugins array literal:
// [...].filter(Boolean) and [...].concat(isProd ? [new X()] : []). The elements
// are statically present in the source; losing them silently drops plugins.
function unwrapPluginsArray(ctx: AnalyzerContext, node: t.Node): t.ArrayExpression | null {
  if (t.isArrayExpression(node)) return node;
  if (t.isTSAsExpression(node) || t.isTSSatisfiesExpression(node)) return unwrapPluginsArray(ctx, node.expression);
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    !node.callee.computed &&
    t.isIdentifier(node.callee.property)
  ) {
    const method = node.callee.property.name;
    if (method === 'filter') return unwrapPluginsArray(ctx, node.callee.object);
    if (method === 'concat') {
      const base = unwrapPluginsArray(ctx, node.callee.object);
      if (!base) return null;
      const elements = [...base.elements];
      for (const arg of node.arguments) {
        if (!collectConcatArg(arg, elements)) {
          ctx.manual(
            'config.dynamic',
            `A non-literal .concat() argument on 'plugins' could not be expanded. Review those plugins manually.`
          );
        }
      }
      return t.arrayExpression(elements);
    }
  }
  return null;
}

function collectConcatArg(arg: t.Node, out: t.ArrayExpression['elements']): boolean {
  if (t.isArrayExpression(arg)) {
    out.push(...arg.elements);
    return true;
  }
  // concat(isProd ? [a] : []) — both branches are statically known plugins.
  if (t.isConditionalExpression(arg)) {
    const a = collectConcatArg(arg.consequent, out);
    const b = collectConcatArg(arg.alternate, out);
    return a && b;
  }
  // concat(new X()) — single-element form.
  if (t.isNewExpression(arg) || t.isCallExpression(arg)) {
    out.push(arg);
    return true;
  }
  return false;
}

function dispatch(ctx: AnalyzerContext, config: t.ObjectExpression): void {
  for (const prop of config.properties) {
    if (t.isSpreadElement(prop)) {
      ctx.manual(
        'config.dynamic',
        `A spread (...) in the top-level config could not be resolved statically. Inline its values; the analyzer cannot expand it.`
      );
      continue;
    }
    if (!t.isObjectProperty(prop) || prop.computed) {
      ctx.manual('config.dynamic', `A dynamic/computed top-level config property could not be analyzed. Review it manually.`);
      continue;
    }
    const key = propName(prop);
    if (!key) continue;
    const value = prop.value as t.Node;

    switch (key) {
      case 'mode':
        ctx.info('config.mode', `'mode' is implicit in Vite (dev server vs 'vite build'). Dropped.`);
        break;
      case 'entry':
        handleEntry(ctx, value);
        break;
      case 'output': {
        const obj = unwrapObject(value);
        if (obj) handleOutput(ctx, obj);
        else dynamicSection(ctx, 'output');
        break;
      }
      case 'resolve': {
        const obj = unwrapObject(value);
        if (obj) handleResolve(ctx, obj);
        else dynamicSection(ctx, 'resolve');
        break;
      }
      case 'module': {
        const obj = unwrapObject(value);
        if (obj) handleModule(ctx, obj);
        else dynamicSection(ctx, 'module');
        break;
      }
      case 'plugins': {
        const arr = unwrapPluginsArray(ctx, value);
        if (arr) handlePlugins(ctx, arr);
        else dynamicSection(ctx, 'plugins');
        break;
      }
      case 'devServer': {
        const obj = unwrapObject(value);
        if (obj) handleDevServer(ctx, obj);
        else dynamicSection(ctx, 'devServer');
        break;
      }
      case 'devtool':
        handleDevtool(ctx, value);
        break;
      case 'optimization': {
        const obj = unwrapObject(value);
        if (obj) handleOptimization(ctx, obj);
        else dynamicSection(ctx, 'optimization');
        break;
      }
      case 'externals':
        handleExternals(ctx, value);
        break;
      case 'target':
        handleTarget(ctx, value);
        break;
      default:
        if (BENIGN_TOP_LEVEL.has(key)) {
          ctx.info('config.unmapped', `'${key}' has no Vite config equivalent and is typically unnecessary. Dropped.`);
        } else {
          ctx.manual('config.unmapped', `Unmapped webpack field '${key}' was not converted. Review and migrate it manually.`);
        }
    }
  }
}
