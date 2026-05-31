/**
 * Per-section handlers. Each handler reads a slice of the webpack config AST,
 * mutates the intermediate ViteModel + flags on the context, and emits tiered
 * warnings. Nothing here renders the final config text — that is render.ts.
 */
import * as t from '@babel/types';
import type { AnalyzerContext } from './types.js';
import {
  evalBoolean,
  evalNode,
  evalNumber,
  evalString,
  getSource,
  propName,
} from './static-eval.js';
import { basename, escapeRegExp, quoteKey, quoteString } from './util.js';

const NODE_PATH_IMPORT = `import path from 'node:path';`;

// Loaders Vite handles internally (transpilation / CSS pipeline). Dropping them
// is safe; we only note it.
const NATIVE_DROP_LOADERS = new Set([
  'babel-loader',
  'ts-loader',
  'swc-loader',
  'esbuild-loader',
  'css-loader',
  'style-loader',
  'postcss-loader',
]);

// Asset loaders: Vite handles assets, but the *import shape* in source may change
// (e.g. `import url from './a.png'` already returns a URL; `?url`/`?raw` suffixes).
const ASSET_LOADERS = new Set(['file-loader', 'url-loader', 'raw-loader']);

const PREPROCESSOR_LOADERS: Record<string, 'sass' | 'less' | 'stylus'> = {
  'sass-loader': 'sass',
  'less-loader': 'less',
  'stylus-loader': 'stylus',
};

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export function handleResolve(ctx: AnalyzerContext, obj: t.ObjectExpression): void {
  let mappedAliases = 0;

  for (const p of obj.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const key = propName(p);
    if (!key) continue;
    const value = p.value as t.Node;

    if (key === 'alias') {
      if (t.isObjectExpression(value)) {
        mappedAliases += handleAliasObject(ctx, value);
      } else {
        ctx.verify(
          'resolve.alias',
          'resolve.alias was not a plain object literal. Copy the alias entries into Vite resolve.alias manually.'
        );
      }
    } else if (key === 'extensions') {
      if (t.isArrayExpression(value)) {
        const exts: string[] = [];
        for (const el of value.elements) {
          const s = el ? evalString(el) : null;
          if (s) exts.push(s);
        }
        if (exts.length > 0) {
          ctx.model.resolve.extensions = exts;
          ctx.info(
            'resolve.extensions',
            `resolve.extensions was copied to Vite resolve.extensions. Vite resolves common extensions by default; trim this if you do not rely on extensionless imports for all of them.`
          );
        }
      }
    } else if (key === 'modules') {
      ctx.info(
        'resolve.modules',
        `resolve.modules is usually unnecessary in Vite. Drop it unless you have a non-standard module directory layout (then prefer resolve.alias).`
      );
    }
    // resolve.fallback (node polyfills) is detected via ProvidePlugin / source scan.
  }

  if (mappedAliases > 0) {
    ctx.info(
      'resolve.alias',
      `${mappedAliases} resolve.alias entr${mappedAliases === 1 ? 'y was' : 'ies were'} mapped to Vite's array-form resolve.alias.`
    );
  }
}

function handleAliasObject(ctx: AnalyzerContext, obj: t.ObjectExpression): number {
  let count = 0;
  for (const p of obj.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const rawKey = propName(p);
    if (rawKey == null) continue;
    const value = p.value as t.Node;

    // Webpack alias array values (multiple fallbacks) do not flatten cleanly.
    if (t.isArrayExpression(value)) {
      ctx.verify(
        'resolve.aliasArrayValue',
        `Alias '${rawKey}' maps to an array of paths. Vite's resolve.alias takes a single replacement; pick the intended target manually instead of flattening.`
      );
      continue;
    }

    const replacement = aliasReplacement(ctx, value);
    if (!replacement) {
      ctx.verify(
        'resolve.alias',
        `Alias '${rawKey}' has a non-static replacement. Copy it into resolve.alias manually.`
      );
      continue;
    }

    const isExact = rawKey.endsWith('$');
    if (isExact) {
      const bare = rawKey.slice(0, -1);
      ctx.model.resolve.alias.push({ find: `/^${escapeRegExp(bare)}$/`, replacement });
      ctx.verify(
        'resolve.aliasExact',
        `Webpack exact-match alias '${rawKey}' was converted to an exact Vite alias rule (/^${escapeRegExp(
          bare
        )}$/). Verify imports like '${bare}/sub/path' still resolve correctly.`
      );
    } else {
      ctx.model.resolve.alias.push({ find: quoteString(rawKey), replacement });
    }
    count++;
  }
  return count;
}

/** Render an alias replacement, keeping path.resolve(...) expressions intact. */
function aliasReplacement(ctx: AnalyzerContext, value: t.Node): string | null {
  if (t.isStringLiteral(value)) return quoteString(value.value);
  // path.resolve(__dirname, 'src') / path.join(...) — keep the expression.
  if (t.isCallExpression(value)) {
    const src = getSource(value);
    if (/\bpath\s*\.\s*(resolve|join)\b/.test(src)) {
      ctx.model.imports.add(NODE_PATH_IMPORT);
      if (src.includes('__dirname')) {
        ctx.verify(
          'resolve.dirnameEsm',
          `Alias replacement uses __dirname. If vite.config.ts runs as ESM, replace __dirname with fileURLToPath(new URL('.', import.meta.url)).`
        );
      }
      return src;
    }
  }
  const evaluated = evalNode(value);
  if (evaluated.ok && typeof evaluated.value === 'string') return quoteString(evaluated.value);
  return null;
}

// ---------------------------------------------------------------------------
// module.rules (loaders)
// ---------------------------------------------------------------------------

interface LoaderUse {
  name: string;
  options?: t.ObjectExpression;
}

export function handleModule(ctx: AnalyzerContext, obj: t.ObjectExpression): void {
  const rulesProp = obj.properties.find(
    (p) => t.isObjectProperty(p) && !p.computed && propName(p) === 'rules'
  );
  if (!rulesProp || !t.isObjectProperty(rulesProp) || !t.isArrayExpression(rulesProp.value)) {
    return;
  }
  for (const rule of rulesProp.value.elements) {
    if (rule) walkRule(ctx, rule);
  }
}

function walkRule(ctx: AnalyzerContext, rule: t.Node): void {
  if (!t.isObjectExpression(rule)) {
    ctx.verify('module.unknownRule', `A module rule could not be read statically. Review it manually.`);
    return;
  }
  // Nested oneOf / rules arrays.
  for (const p of rule.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const k = propName(p);
    if ((k === 'oneOf' || k === 'rules') && t.isArrayExpression(p.value)) {
      for (const nested of p.value.elements) if (nested) walkRule(ctx, nested);
    }
  }

  for (const use of extractLoaderUses(rule)) classifyLoader(ctx, use);
}

function extractLoaderUses(rule: t.ObjectExpression): LoaderUse[] {
  const uses: LoaderUse[] = [];
  for (const p of rule.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const k = propName(p);
    if (k === 'loader' && t.isStringLiteral(p.value)) {
      uses.push({ name: p.value.value });
    } else if (k === 'use') {
      collectUse(p.value as t.Node, uses);
    }
  }
  return uses;
}

function collectUse(node: t.Node, out: LoaderUse[]): void {
  if (t.isStringLiteral(node)) {
    out.push({ name: node.value });
  } else if (t.isArrayExpression(node)) {
    for (const el of node.elements) if (el) collectUse(el, out);
  } else if (t.isObjectExpression(node)) {
    const loaderProp = node.properties.find(
      (p) => t.isObjectProperty(p) && !p.computed && propName(p) === 'loader'
    );
    const optionsProp = node.properties.find(
      (p) => t.isObjectProperty(p) && !p.computed && propName(p) === 'options'
    );
    if (loaderProp && t.isObjectProperty(loaderProp) && t.isStringLiteral(loaderProp.value)) {
      const options =
        optionsProp && t.isObjectProperty(optionsProp) && t.isObjectExpression(optionsProp.value)
          ? optionsProp.value
          : undefined;
      out.push({ name: loaderProp.value.value, options });
    }
  }
}

/** Normalize 'css-loader?modules' / absolute paths to a bare loader package name. */
function normalizeLoaderName(name: string): string {
  let n = name.split('?')[0]!; // strip inline query
  n = n.replace(/\\/g, '/');
  // an absolute/relative path to node_modules/<loader>/...
  const m = n.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (m) return m[1]!;
  return n;
}

function classifyLoader(ctx: AnalyzerContext, use: LoaderUse): void {
  const name = normalizeLoaderName(use.name);

  if (name === '@svgr/webpack') {
    ctx.flags.needsSvgr = true;
    ctx.model.imports.add(`import svgr from 'vite-plugin-svgr';`);
    if (!ctx.model.plugins.includes('svgr()')) ctx.model.plugins.push('svgr()');
    ctx.verify(
      'module.svgr',
      `@svgr/webpack was replaced with vite-plugin-svgr. Update source imports to the '?react' suffix, e.g. import Logo from './logo.svg?react'.`
    );
    return;
  }

  if (name === 'worker-loader') {
    ctx.flags.hasWebWorkers = true;
    ctx.manual(
      'module.workerLoader',
      `worker-loader has no Vite config equivalent. Vite uses query suffixes: import Worker from './w.ts?worker' (or '?worker&inline'). Update worker imports in source.`
    );
    return;
  }

  const preprocessor = PREPROCESSOR_LOADERS[name];
  if (preprocessor) {
    if (preprocessor === 'sass') ctx.flags.needsSass = true;
    if (preprocessor === 'less') ctx.flags.needsLess = true;
    if (preprocessor === 'stylus') ctx.flags.needsStylus = true;
    ctx.verify(
      'module.preprocessor',
      `${name} maps to Vite's built-in ${preprocessor} support. Install the '${preprocessor}' compiler package; no loader config is needed. Verify any loader options (additionalData, includePaths) are moved to css.preprocessorOptions.`
    );
    return;
  }

  if (name === 'css-loader') {
    detectCssModules(ctx, use.options);
    ctx.info(
      'module.nativeLoader',
      `${name} is handled natively by Vite's CSS pipeline. No loader is needed.`
    );
    return;
  }

  if (NATIVE_DROP_LOADERS.has(name)) {
    const msg =
      name === 'babel-loader' || name === 'ts-loader' || name === 'swc-loader' || name === 'esbuild-loader'
        ? `${name} is unnecessary: Vite transpiles TS/JSX via esbuild. Note Vite does NOT type-check — run 'tsc --noEmit' (or vite-plugin-checker) separately.`
        : `${name} is handled natively by Vite's CSS pipeline. No loader is needed.`;
    ctx.info('module.nativeLoader', msg);
    return;
  }

  if (ASSET_LOADERS.has(name)) {
    ctx.verify(
      'module.assetLoader',
      `${name} is unnecessary: Vite handles assets natively. The import shape may change — use '?url' for an asset URL and '?raw' for file contents. Verify asset imports in source.`
    );
    return;
  }

  ctx.flags.hasCustomLoaders = true;
  ctx.manual(
    'module.customLoader',
    `Loader '${name}' has no known Vite equivalent. Find a matching Vite plugin or rework the transform; it cannot be mapped from config alone.`
  );
}

function detectCssModules(ctx: AnalyzerContext, options?: t.ObjectExpression): void {
  if (!options) return;
  const modulesProp = options.properties.find(
    (p) => t.isObjectProperty(p) && !p.computed && propName(p) === 'modules'
  );
  if (!modulesProp || !t.isObjectProperty(modulesProp)) return;
  const v = modulesProp.value as t.Node;
  // `modules: 'global'`/`'local'`/true/{...} all imply opt-in CSS Modules that
  // are not gated on the `.module.css` suffix that Vite keys off of.
  const isOptIn =
    (t.isBooleanLiteral(v) && v.value === true) ||
    t.isObjectExpression(v) ||
    (t.isStringLiteral(v) && v.value !== 'auto');
  if (isOptIn) {
    ctx.flags.usesCssModulesWithoutModuleSuffix = true;
    ctx.verify(
      'module.cssModulesNaming',
      `css-loader enables CSS Modules without relying on the '.module.css' suffix. Vite treats only '*.module.css' as CSS Modules by default. Rename files to '*.module.css' or configure css.modules. Any custom localIdentName belongs in css.modules.generateScopedName.`
    );
  }
}

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

const BENIGN_PLUGINS = new Set([
  'HotModuleReplacementPlugin',
  'CleanWebpackPlugin',
  'CaseSensitivePathsPlugin',
  'WebpackManifestPlugin',
]);

export function handlePlugins(ctx: AnalyzerContext, arr: t.ArrayExpression): void {
  for (const el of arr.elements) {
    if (!el) continue;
    const name = pluginName(el);
    if (!name) {
      ctx.flags.hasComplexPlugins = true;
      ctx.verify(
        'plugin.unknown',
        `A plugin entry could not be identified statically. Review it against the Vite plugin ecosystem manually.`
      );
      continue;
    }
    const args = t.isNewExpression(el) ? (el.arguments as t.Node[]) : [];
    classifyPlugin(ctx, name, args);
  }
}

function pluginName(node: t.Node): string | null {
  if (t.isNewExpression(node)) {
    if (t.isIdentifier(node.callee)) return node.callee.name;
    if (t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property)) {
      return node.callee.property.name;
    }
  }
  // Some plugins are factory calls, e.g. `sentryVitePlugin({...})` — best-effort.
  if (t.isCallExpression(node) && t.isIdentifier(node.callee)) return node.callee.name;
  return null;
}

function classifyPlugin(ctx: AnalyzerContext, name: string, args: t.Node[]): void {
  switch (name) {
    case 'DefinePlugin':
      handleDefinePlugin(ctx, args[0]);
      return;
    case 'EnvironmentPlugin':
      ctx.verify(
        'plugin.define',
        `EnvironmentPlugin injects process.env.* values. In Vite, expose them via VITE_-prefixed env vars and import.meta.env, or map them into 'define'. Migrate the referenced env vars in source.`
      );
      ctx.flags.hasProcessEnvSource = true;
      return;
    case 'HtmlWebpackPlugin':
      ctx.flags.hasHtmlPlugin = true;
      ctx.verify(
        'plugin.html',
        `HtmlWebpackPlugin → Vite is HTML-first. Create an index.html at the project root with <script type="module" src="/src/entry.tsx"></script>. Move template variables/<%= %> interpolation to Vite's HTML env replacement or a plugin. Verify favicon/meta injection.`
      );
      return;
    case 'MiniCssExtractPlugin':
      ctx.info(
        'plugin.miniCss',
        `MiniCssExtractPlugin is unnecessary: 'vite build' extracts CSS automatically. Drop it (and its loader).`
      );
      return;
    case 'CopyWebpackPlugin':
    case 'CopyPlugin':
      ctx.flags.needsStaticCopy = true;
      ctx.verify(
        'plugin.copy',
        `CopyWebpackPlugin → prefer Vite's publicDir for files served as-is. For custom source/target patterns, use vite-plugin-static-copy. Verify each copy pattern.`
      );
      return;
    case 'ProvidePlugin':
      handleProvide(ctx, args[0]);
      return;
    case 'ForkTsCheckerWebpackPlugin':
    case 'ESLintPlugin':
    case 'ESLintWebpackPlugin':
      ctx.flags.needsChecker = true;
      ctx.verify(
        'plugin.checker',
        `${name} → run type/lint checks in CI, or add vite-plugin-checker for in-dev overlays (Vite does not type-check or lint during build).`
      );
      return;
    case 'CompressionPlugin':
      ctx.flags.needsCompression = true;
      ctx.verify(
        'plugin.compression',
        `CompressionPlugin → only needed if you serve precompressed .gz/.br assets yourself. If so, add vite-plugin-compression2; otherwise let your CDN/host compress.`
      );
      return;
    case 'BundleAnalyzerPlugin':
      ctx.flags.needsVisualizer = true;
      ctx.info(
        'plugin.visualizer',
        `BundleAnalyzerPlugin → use rollup-plugin-visualizer (works with Vite/Rolldown) to inspect bundle composition.`
      );
      return;
    case 'ModuleFederationPlugin':
      ctx.flags.hasModuleFederation = true;
      ctx.manual(
        'plugin.federation',
        `ModuleFederationPlugin is an architecture-level feature with no drop-in config mapping. Evaluate @originjs/vite-plugin-federation separately; remotes/shared/exposes semantics differ from webpack. This analyzer does not migrate it.`
      );
      return;
    default:
      if (BENIGN_PLUGINS.has(name)) {
        ctx.info(
          'plugin.benign',
          `${name} is unnecessary in Vite (HMR, output cleaning, and case-sensitivity checks are built in or handled by 'vite build'). Drop it.`
        );
        return;
      }
      ctx.flags.hasComplexPlugins = true;
      ctx.manual(
        'plugin.unknown',
        `Plugin '${name}' was not classified. Check whether an equivalent Vite plugin exists or whether Vite handles it natively; it cannot be mapped from config alone.`
      );
  }
}

export function handleDefinePlugin(ctx: AnalyzerContext, arg: t.Node | undefined): void {
  if (!arg || !t.isObjectExpression(arg)) {
    ctx.verify(
      'plugin.define',
      `DefinePlugin was found but its replacement object could not be read statically. Copy the constants into Vite 'define' manually.`
    );
    return;
  }

  let mapped = 0;
  for (const p of arg.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const key = propName(p);
    if (key == null) continue;

    // process.env.NODE_ENV is set automatically by Vite per --mode; drop it.
    if (key === 'process.env.NODE_ENV') {
      ctx.info(
        'plugin.defineEnv',
        `DefinePlugin 'process.env.NODE_ENV' was dropped — Vite sets it (and import.meta.env.MODE) automatically based on the run mode.`
      );
      continue;
    }

    const valueSrc = getSource(p.value as t.Node);
    const isProcessEnv = key === 'process.env' || key.startsWith('process.env.');

    ctx.model.define.set(quoteKey(key), {
      value: valueSrc,
      comment: isProcessEnv ? 'compatibility shim' : undefined,
    });
    mapped++;

    if (isProcessEnv) {
      ctx.flags.hasProcessEnvSource = true;
      const envName = key.slice('process.env.'.length);
      ctx.manual(
        'plugin.defineEnv',
        `'${key}' was mapped to Vite 'define' as a compatibility shim. Prefer migrating it in source to import.meta.env.VITE_${
          envName || 'NAME'
        } (only VITE_-prefixed vars are exposed to client code) or an explicit runtime-config pattern.`
      );
    }
  }

  if (mapped > 0) {
    ctx.verify(
      'plugin.define',
      `DefinePlugin constants were mapped to Vite 'define'. These are static build-time text replacements — verify any values that depended on webpack runtime context.`
    );
  }
}

function handleProvide(ctx: AnalyzerContext, arg: t.Node | undefined): void {
  let touchesNodeGlobals = false;
  if (arg && t.isObjectExpression(arg)) {
    for (const p of arg.properties) {
      if (!t.isObjectProperty(p) || p.computed) continue;
      const key = propName(p);
      if (key && /^(Buffer|process|global)$/.test(key)) touchesNodeGlobals = true;
    }
  }
  if (touchesNodeGlobals) {
    ctx.flags.needsNodePolyfills = true;
    ctx.manual(
      'plugin.provide',
      `ProvidePlugin auto-injects globals (Buffer/process/global). Vite has no direct equivalent. For Node globals in browser code, evaluate vite-plugin-node-polyfills (use sparingly), or add explicit imports/define a 'global' shim. Prefer removing the dependency on Node globals.`
    );
  } else {
    ctx.manual(
      'plugin.provide',
      `ProvidePlugin auto-imports identifiers (e.g. $ → jquery). Vite has no equivalent; add explicit imports in the modules that use them, or use a small inject plugin.`
    );
  }
}

// ---------------------------------------------------------------------------
// devServer
// ---------------------------------------------------------------------------

export function handleDevServer(ctx: AnalyzerContext, obj: t.ObjectExpression): void {
  let mappedBasic = false;
  for (const p of obj.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const key = propName(p);
    if (!key) continue;
    const value = p.value as t.Node;

    switch (key) {
      case 'port': {
        const n = evalNumber(value);
        ctx.model.server.port = n != null ? String(n) : getSource(value);
        mappedBasic = true;
        break;
      }
      case 'host':
        ctx.model.server.host = getSource(value);
        mappedBasic = true;
        break;
      case 'open': {
        const b = evalBoolean(value);
        ctx.model.server.open = b != null ? String(b) : getSource(value);
        mappedBasic = true;
        break;
      }
      case 'https':
      case 'server': // webpack 5 renamed https -> server: { type: 'https' }
        ctx.model.server.https = key === 'https' ? getSource(value) : 'true';
        mappedBasic = true;
        break;
      case 'proxy':
        handleProxy(ctx, value);
        break;
      case 'historyApiFallback':
        ctx.info(
          'devServer.basic',
          `devServer.historyApiFallback is unnecessary: Vite serves index.html for unmatched routes in dev. For SPA fallback in preview/build, configure your host.`
        );
        break;
      case 'hot':
      case 'liveReload':
        ctx.info('devServer.basic', `devServer.${key} is unnecessary: Vite has HMR enabled by default.`);
        break;
      case 'static':
      case 'contentBase':
        ctx.info(
          'devServer.basic',
          `devServer.${key} maps loosely to Vite's publicDir (files served as-is from root). Verify the directory.`
        );
        break;
      default:
        ctx.info(
          'devServer.basic',
          `devServer.${key} has no exact Vite equivalent. Check the Vite 'server' options; many webpack-dev-server behaviors are built in.`
        );
    }
  }
  if (mappedBasic) {
    ctx.info('devServer.basic', `Basic devServer options (port/host/open/https) were mapped to Vite 'server'.`);
  }
}

function handleProxy(ctx: AnalyzerContext, value: t.Node): void {
  // webpack 5 array form: [{ context: ['/api'], target, ... }]
  if (t.isArrayExpression(value)) {
    ctx.verify(
      'devServer.proxy',
      `devServer.proxy uses the array form. Vite's server.proxy is a keyed object ({ '/api': { target, ... } }). Rebuild each entry manually.`
    );
    return;
  }
  if (!t.isObjectExpression(value)) {
    ctx.verify('devServer.proxy', `devServer.proxy could not be read statically. Recreate server.proxy manually.`);
    return;
  }

  const entries: string[] = [];
  for (const p of value.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const ctxPath = propName(p);
    if (ctxPath == null) continue;
    const v = p.value as t.Node;

    if (t.isStringLiteral(v)) {
      entries.push(`${quoteKey(ctxPath)}: { target: ${quoteString(v.value)}, changeOrigin: true }`);
      continue;
    }
    if (t.isObjectExpression(v)) {
      entries.push(`${quoteKey(ctxPath)}: ${renderProxyTarget(ctx, ctxPath, v)}`);
      continue;
    }
    ctx.verify(
      'devServer.proxy',
      `Proxy entry '${ctxPath}' is not a static string/object. Recreate it under server.proxy manually.`
    );
  }

  if (entries.length > 0) {
    // Indented to sit under `    proxy: ` (server entries are at 4 spaces).
    ctx.model.server.proxy = `{\n      ${entries.join(',\n      ')},\n    }`;
    ctx.verify(
      'devServer.proxy',
      `devServer.proxy was mapped to Vite server.proxy. Vite mirrors http-proxy options (target, changeOrigin, secure, ws). Verify each route.`
    );
  }
}

function renderProxyTarget(ctx: AnalyzerContext, ctxPath: string, obj: t.ObjectExpression): string {
  const parts: string[] = [];
  let rewrite: string | null = null;

  for (const p of obj.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const key = propName(p);
    if (!key) continue;
    const v = p.value as t.Node;

    if (key === 'pathRewrite') {
      rewrite = buildRewrite(ctx, ctxPath, v);
      continue;
    }
    if (key === 'target' || key === 'changeOrigin' || key === 'secure' || key === 'ws' || key === 'xfwd') {
      parts.push(`${key}: ${getSource(v)}`);
      continue;
    }
    // Unknown keys: keep verbatim so nothing is silently dropped.
    parts.push(`${quoteKey(key)}: ${getSource(v)}`);
  }
  if (!parts.some((s) => s.startsWith('changeOrigin'))) parts.push('changeOrigin: true');
  if (rewrite) parts.push(rewrite);
  return `{ ${parts.join(', ')} }`;
}

function buildRewrite(ctx: AnalyzerContext, ctxPath: string, value: t.Node): string | null {
  if (t.isObjectExpression(value) && value.properties.length === 1) {
    const only = value.properties[0];
    if (only && t.isObjectProperty(only) && !only.computed) {
      const from = propName(only);
      const to = evalString(only.value as t.Node);
      if (from != null && to != null) {
        ctx.verify(
          'devServer.proxyRewrite',
          `Proxy '${ctxPath}' pathRewrite { '${from}': '${to}' } was converted to a rewrite function. Verify the regex semantics match.`
        );
        ctx.flags.hasProxyRewrite = true;
        return `rewrite: (p) => p.replace(${regexFromRewriteKey(from)}, ${quoteString(to)})`;
      }
    }
  }
  ctx.verify(
    'devServer.proxyRewrite',
    `Proxy '${ctxPath}' pathRewrite is non-trivial. Rebuild it as a Vite 'rewrite: (path) => ...' function manually.`
  );
  ctx.flags.hasProxyRewrite = true;
  return null;
}

function regexFromRewriteKey(key: string): string {
  // pathRewrite keys are already regex source strings (e.g. '^/api').
  // Emit them as a regex literal, escaping only the closing delimiter.
  return `/${key.replace(/\//g, '\\/')}/`;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export function handleEntry(ctx: AnalyzerContext, value: t.Node): void {
  if (t.isStringLiteral(value)) {
    ctx.model.build.input = quoteString(value.value);
    ctx.verify(
      'entry.mapped',
      `entry was mapped into Vite build input, but Vite's normal application entry is HTML-first: an index.html with <script type="module">. Verify index.html and its script tags rather than relying on build input alone.`
    );
    return;
  }

  if (t.isObjectExpression(value)) {
    ctx.flags.hasMultiEntry = true;
    const entries: string[] = [];
    for (const p of value.properties) {
      if (!t.isObjectProperty(p) || p.computed) continue;
      const name = propName(p);
      if (name == null) continue;
      const target = entryTarget(p.value as t.Node);
      if (target) entries.push(`${quoteKey(name)}: ${target}`);
    }
    if (entries.length > 0) {
      ctx.model.build.input = `{ ${entries.join(', ')} }`;
    }
    ctx.verify(
      'entry.multiPage',
      `Multiple entry points were mapped to a build input map. Vite is multi-PAGE via multiple HTML files (one per entry) rather than multiple JS entries. For a true MPA, create an HTML file per page; for a library, this input map is closer. Verify the intended shape.`
    );
    return;
  }

  if (t.isArrayExpression(value)) {
    const first = value.elements.find((e): e is t.Expression => e != null && t.isStringLiteral(e));
    if (first && t.isStringLiteral(first)) ctx.model.build.input = quoteString(first.value);
    ctx.verify(
      'entry.dynamic',
      `entry is an array (multiple files bundled into one). Vite expects a single module entry; merge them, or import the extra files from your main entry. The first entry was used as a placeholder.`
    );
    return;
  }

  ctx.manual(
    'entry.dynamic',
    `entry is computed (function or dynamic value). It cannot be mapped from config alone — set Vite's HTML entry / build.input manually.`
  );
}

function entryTarget(node: t.Node): string | null {
  if (t.isStringLiteral(node)) return quoteString(node.value);
  if (t.isArrayExpression(node)) {
    const first = node.elements.find((e): e is t.StringLiteral => e != null && t.isStringLiteral(e));
    if (first) return quoteString(first.value);
  }
  if (t.isObjectExpression(node)) {
    // { import: './x', dependOn: '...' }
    const imp = node.properties.find(
      (p) => t.isObjectProperty(p) && !p.computed && propName(p) === 'import'
    );
    if (imp && t.isObjectProperty(imp)) return entryTarget(imp.value as t.Node);
  }
  return null;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

export function handleOutput(ctx: AnalyzerContext, obj: t.ObjectExpression): void {
  for (const p of obj.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const key = propName(p);
    if (!key) continue;
    const value = p.value as t.Node;

    switch (key) {
      case 'path': {
        const resolved = evalString(value);
        if (resolved) {
          const dir = basename(resolved) || 'dist';
          ctx.model.build.outDir = quoteString(dir);
          ctx.info(
            'output.outDir',
            `output.path was mapped to build.outDir ('${dir}'). Vite's outDir is relative to the project root; verify the location.`
          );
        } else {
          ctx.verify(
            'output.outDir',
            `output.path is not statically resolvable. Set build.outDir manually (Vite outDir is relative to the root).`
          );
        }
        break;
      }
      case 'publicPath': {
        const resolved = evalString(value);
        if (resolved === 'auto' || resolved === '') {
          ctx.verify(
            'output.publicPath',
            `output.publicPath '${resolved}' has no fixed Vite mapping. Vite's 'base' defaults to '/'. Set 'base' if you deploy under a sub-path.`
          );
        } else if (resolved) {
          ctx.model.build.base = quoteString(resolved);
          ctx.verify(
            'output.publicPath',
            `output.publicPath was mapped to Vite 'base' ('${resolved}'). Verify it matches your deploy sub-path (Vite 'base' affects asset URLs).`
          );
        } else {
          ctx.verify(
            'output.publicPath',
            `output.publicPath is dynamic. Set Vite 'base' manually to match your deploy path.`
          );
        }
        break;
      }
      case 'filename':
        ctx.model.build.entryFileNames = getSource(value);
        ctx.verify(
          'output.naming',
          `output.filename does not map 1:1 — Vite/Rolldown output naming differs from webpack ([name]/[contenthash] tokens differ). The value was kept as a hint comment; set build.rolldownOptions.output.entryFileNames if you rely on exact names.`
        );
        break;
      case 'chunkFilename':
        ctx.model.build.chunkFileNames = getSource(value);
        ctx.verify(
          'output.naming',
          `output.chunkFilename does not map 1:1. The value was kept as a hint comment; set output.chunkFileNames if you rely on exact chunk names.`
        );
        break;
      case 'clean':
        ctx.info('output.outDir', `output.clean is the default in Vite ('vite build' empties outDir). Drop it.`);
        break;
      // library / globalObject / assetModuleFilename etc. are out of v0.1 scope.
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// devtool
// ---------------------------------------------------------------------------

export function handleDevtool(ctx: AnalyzerContext, value: t.Node): void {
  const b = evalBoolean(value);
  if (b === false) {
    ctx.model.build.sourcemap = 'false';
    ctx.info('devtool.sourcemap', `devtool: false was mapped to build.sourcemap: false.`);
    return;
  }
  const s = evalString(value);
  if (s === 'source-map') {
    ctx.model.build.sourcemap = 'true';
    ctx.info('devtool.sourcemap', `devtool 'source-map' was mapped to build.sourcemap: true.`);
  } else if (s === 'inline-source-map') {
    ctx.model.build.sourcemap = `'inline'`;
    ctx.info('devtool.sourcemap', `devtool 'inline-source-map' was mapped to build.sourcemap: 'inline'.`);
  } else if (s === 'hidden-source-map') {
    ctx.model.build.sourcemap = `'hidden'`;
    ctx.info('devtool.sourcemap', `devtool 'hidden-source-map' was mapped to build.sourcemap: 'hidden'.`);
  } else if (s) {
    ctx.verify(
      'devtool.sourcemap',
      `devtool '${s}' has no exact Vite mapping. Vite controls dev source maps internally; for production set build.sourcemap (true/'inline'/'hidden').`
    );
  } else {
    ctx.verify(
      'devtool.sourcemap',
      `devtool is dynamic. Set build.sourcemap (true/'inline'/'hidden'/false) manually.`
    );
  }
}

// ---------------------------------------------------------------------------
// optimization
// ---------------------------------------------------------------------------

export function handleOptimization(ctx: AnalyzerContext, value: t.Node): void {
  if (!t.isObjectExpression(value)) return;
  for (const p of value.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const key = propName(p);
    if (!key) continue;

    switch (key) {
      case 'splitChunks':
        ctx.flags.hasSplitChunks = true;
        ctx.model.build.codeSplittingNote = true;
        if (ctx.flags.targetViteMajor === 8) ctx.model.vite8NoteNeeded = true;
        ctx.verify(
          'optimization.splitChunks',
          `optimization.splitChunks has no direct mapping. Vite/Rolldown code-split automatically. ${
            ctx.flags.targetViteMajor === 8
              ? 'For manual control use Rolldown codeSplitting (object-form manualChunks was removed in Vite 8).'
              : 'For manual control use build.rollupOptions.output.manualChunks.'
          } A stub was added — port only the grouping you truly rely on.`
        );
        break;
      case 'runtimeChunk':
        ctx.info(
          'optimization.splitChunks',
          `optimization.runtimeChunk has no equivalent and is unnecessary: Vite/Rolldown manage the runtime/module graph automatically.`
        );
        break;
      case 'minimize':
      case 'minimizer':
        ctx.info(
          'optimization.splitChunks',
          `optimization.${key} is unnecessary: 'vite build' minifies by default (esbuild). Set build.minify only to change/disable it.`
        );
        break;
      default:
        ctx.info(
          'optimization.splitChunks',
          `optimization.${key} is largely automatic in Vite/Rolldown. Port it only if you explicitly depend on it.`
        );
    }
  }
}

// ---------------------------------------------------------------------------
// externals
// ---------------------------------------------------------------------------

export function handleExternals(ctx: AnalyzerContext, _value: t.Node): void {
  ctx.flags.hasExternals = true;
  if (ctx.flags.targetViteMajor === 8) ctx.model.vite8NoteNeeded = true;
  ctx.manual(
    'externals.detected',
    `externals was detected. Vite/Rolldown external semantics differ from webpack — review build.${
      ctx.flags.targetViteMajor === 8 ? 'rolldownOptions' : 'rollupOptions'
    }.external manually. ${
      ctx.flags.targetViteMajor === 8
        ? 'In Vite 8, require() calls for externalized modules are preserved unless you opt into esmExternalRequirePlugin.'
        : ''
    }`.trim()
  );
}

// ---------------------------------------------------------------------------
// target
// ---------------------------------------------------------------------------

export function handleTarget(ctx: AnalyzerContext, value: t.Node): void {
  const s = evalString(value);
  if (s === 'web') {
    ctx.info('target.web', `target: 'web' is the Vite default. Dropped.`);
    return;
  }
  if (s && /^(node|electron|nwjs|node-webkit)/.test(s)) {
    ctx.manual(
      'target.ssr',
      `target '${s}' is a non-browser/SSR target. Vite handles SSR/library builds differently (build.ssr, ssr options, or a framework SSR setup). Migrate this manually.`
    );
    return;
  }
  if (t.isArrayExpression(value)) {
    ctx.verify(
      'target.ssr',
      `target is an array. Browser build targets map to build.target; any non-browser target needs a separate SSR/library setup. Verify the split manually.`
    );
    return;
  }
  if (s) {
    ctx.verify(
      'target.ssr',
      `target '${s}' likely maps to build.target (browser support level). Verify against Vite's build.target / browser baseline.`
    );
  }
}

// ---------------------------------------------------------------------------
// optional source scan (CLI / advanced)
// ---------------------------------------------------------------------------

export function scanSource(ctx: AnalyzerContext, files: Array<{ path: string; content: string }>): void {
  // Detection-only: surfaces source-level traps the config cannot reveal. This
  // is intentionally a lightweight textual scan, gated behind an explicit
  // sourceFiles opt-in (it never affects basic config conversion).
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  for (const file of files) {
    const code = stripComments(file.content);

    if (/\brequire\.context\s*\(/.test(code)) {
      ctx.flags.hasRequireContext = true;
      ctx.manual(
        'source.requireContext',
        `require.context() is webpack-specific. Replace it with Vite's import.meta.glob() (eager or lazy).`,
        file.path
      );
    }
    const requireSpecifiers = [...code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
    const hasBareRequire = requireSpecifiers.some((s) => !s.startsWith('.'));
    if (requireSpecifiers.length > 0 || /\bmodule\.exports\b/.test(code)) {
      ctx.flags.hasCommonJsSource = true;
      if (hasBareRequire) ctx.flags.hasCommonJsDependencies = true;
      ctx.info(
        'source.require',
        `CommonJS (require/module.exports) detected in source. Vite is ESM-first; convert app source to import/export. Vite pre-bundles CJS dependencies, but ${
          hasBareRequire ? 'a CJS dependency was require()d directly — ' : ''
        }prefer ESM entry points.`,
        file.path
      );
    }
    if (/process\.env\.[A-Za-z_]/.test(code)) {
      ctx.flags.hasProcessEnvSource = true;
      ctx.verify(
        'source.processEnv',
        `process.env.* usage detected in source. In the browser build, migrate to import.meta.env.VITE_* (only VITE_-prefixed vars are exposed).`,
        file.path
      );
    }
    if (/worker-loader!/.test(code) || /new\s+Worker\s*\(/.test(code)) {
      ctx.flags.hasWebWorkers = true;
      ctx.verify(
        'source.worker',
        `Web Worker usage detected. In Vite, import workers with the '?worker' suffix (or new Worker(new URL('./w.ts', import.meta.url), { type: 'module' })).`,
        file.path
      );
    }
    if (/\bmodule\.hot\b/.test(code)) {
      ctx.info(
        'source.moduleHot',
        `module.hot (webpack HMR API) detected. Vite uses import.meta.hot with a similar but distinct API. Update HMR acceptance code.`,
        file.path
      );
    }
    // Dynamic import() with a variable/template — works in webpack, breaks in Vite.
    if (/\bimport\s*\(\s*[`'"][^`'")]*\$\{/.test(code) || /\bimport\s*\(\s*[^)'"`]*[+]/.test(code)) {
      ctx.flags.hasRequireContext = true;
      ctx.manual(
        'source.requireContext',
        `A dynamic import() with a computed/variable specifier was detected. Vite cannot analyze it the way webpack does — replace it with import.meta.glob() using a static glob.`,
        file.path
      );
    }
  }
}
