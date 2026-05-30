import * as parser from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import _generator from '@babel/generator';
import * as t from '@babel/types';

// Babel ships CJS that interops oddly with NodeNext + strict TS. The runtime
// check picks the callable regardless of how the bundler resolves default.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse: any =
  typeof _traverse === 'function' ? _traverse : (_traverse as unknown as { default: unknown }).default;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const generate: any =
  typeof _generator === 'function' ? _generator : (_generator as unknown as { default: unknown }).default;

export interface Warning {
  type: 'manual' | 'verify' | 'info';
  message: string;
}

export interface ConvertOptions {
  /** Reserved for future output-shape options. */
  format?: boolean;
}

export interface ConversionFlags {
  needsSvgr: boolean;
  needsSass: boolean;
  hasCustomLoaders: boolean;
  hasComplexPlugins: boolean;
}

export interface ConversionResult {
  output: string;
  warnings: Warning[];
  flags: ConversionFlags;
}

function emptyFlags(): ConversionFlags {
  return { needsSvgr: false, needsSass: false, hasCustomLoaders: false, hasComplexPlugins: false };
}

// Loaders Vite handles natively (no plugin needed) vs ones that map to a plugin/dep.
const NATIVE_LOADERS = new Set([
  'babel-loader',
  'ts-loader',
  'esbuild-loader',
  'style-loader',
  'css-loader',
  'postcss-loader',
  'file-loader',
  'url-loader',
  'raw-loader',
  'json-loader',
]);

/**
 * Analyze a Webpack config (`webpack.config.js`) and emit a `vite.config.ts`
 * skeleton plus a classification of what maps cleanly, what needs a Vite plugin,
 * and what needs manual work.
 *
 * NOTE: This is the initial skeleton — it establishes the parse → classify → emit
 * pipeline and the warning tiers, and handles the common surface (resolve, the
 * loaders in module.rules, well-known plugins, devServer). Deeper coverage of
 * exotic loaders/plugins and function-form configs is the work to fill in.
 */
export function analyzeWebpackConfig(input: string, _options: ConvertOptions = {}): ConversionResult {
  const warnings: Warning[] = [];
  const seen = new Set<string>();
  const warn = (type: Warning['type'], message: string) => {
    const key = `${type}::${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push({ type, message });
  };

  const ast = parseInput(input);
  if (!ast) {
    return {
      output: `// Failed to parse webpack config as JavaScript/TypeScript.\n\n${input}`,
      warnings: [{ type: 'manual', message: 'Could not parse the input as a JavaScript/TypeScript webpack config.' }],
      flags: emptyFlags(),
    };
  }

  const config = findConfigObject(ast);
  if (!config) {
    return {
      output:
        `// Could not find a webpack config object.\n` +
        `// Expected module.exports = {...}, export default {...}, or a function returning a config object.\n\n${input}`,
      warnings: [{ type: 'manual', message: 'Could not detect a webpack config object (module.exports / export default / function form).' }],
      flags: emptyFlags(),
    };
  }

  const flags = emptyFlags();
  const resolveAlias: Array<[string, string]> = [];
  const resolveExtensions: string[] = [];
  const serverLines: string[] = [];
  const definePresent = { value: false };

  for (const prop of config.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) {
      warn('verify', 'A dynamic/spread property in the webpack config could not be statically analyzed. Review it manually.');
      continue;
    }
    const key = propName(prop);
    if (!key) continue;
    const value = prop.value as t.Node;

    switch (key) {
      case 'mode':
        warn('info', `'mode' is implicit in Vite (dev server vs 'vite build'). Dropped.`);
        break;
      case 'entry':
        warn('verify', `'entry' maps to an HTML entry in Vite (index.html with a <script type="module">), or build.rollupOptions.input for multi-entry/library builds. Set it up manually.`);
        break;
      case 'output':
        warn('verify', `'output' maps to Vite 'build' (outDir, assetsDir, build.rollupOptions.output). Translate path/filename/publicPath manually.`);
        break;
      case 'resolve':
        if (t.isObjectExpression(value)) handleResolve(value, resolveAlias, resolveExtensions);
        break;
      case 'module':
        if (t.isObjectExpression(value)) handleModule(value);
        break;
      case 'plugins':
        if (t.isArrayExpression(value)) handlePlugins(value);
        break;
      case 'devServer':
        if (t.isObjectExpression(value)) handleDevServer(value, serverLines);
        break;
      case 'devtool':
        warn('info', `'devtool' maps to Vite 'build.sourcemap' (boolean/'inline'/'hidden'). Set it there if you need source maps in production.`);
        break;
      case 'optimization':
        warn('verify', `'optimization' (splitChunks, minimize, runtimeChunk) is largely automatic in Vite/Rollup. Port only the parts you explicitly rely on to build.rollupOptions.`);
        break;
      case 'externals':
        warn('manual', `'externals' maps to build.rollupOptions.external (and optionally 'output.globals'). Translate manually.`);
        break;
      case 'target':
        warn('verify', `'target' maps to Vite 'build.target' and/or 'ssr' options depending on intent. Verify.`);
        break;
      default:
        warn('manual', `Unmapped webpack field '${key}' was not converted. Review and migrate it manually.`);
    }
  }

  const output = render({ resolveAlias, resolveExtensions, serverLines, definePresent, flags });
  return { output, warnings, flags };

  // ---- handlers (closures over warn/flags) ----

  function handleResolve(obj: t.ObjectExpression, alias: Array<[string, string]>, exts: string[]) {
    for (const p of obj.properties) {
      if (!t.isObjectProperty(p) || p.computed) continue;
      const k = propName(p);
      if (k === 'alias' && t.isObjectExpression(p.value)) {
        for (const a of p.value.properties) {
          if (!t.isObjectProperty(a) || a.computed) continue;
          const ak = propName(a);
          if (ak && t.isStringLiteral(a.value)) alias.push([ak, a.value.value]);
          else if (ak) warn('verify', `resolve.alias '${ak}' has a non-string target; copy it into resolve.alias manually.`);
        }
      } else if (k === 'extensions' && t.isArrayExpression(p.value)) {
        for (const el of p.value.elements) if (t.isStringLiteral(el)) exts.push(el.value);
      } else if (k === 'modules') {
        warn('info', `resolve.modules is usually unnecessary in Vite. Drop it unless you have a non-standard layout.`);
      }
    }
  }

  function handleModule(obj: t.ObjectExpression) {
    const rules = obj.properties.find((p) => t.isObjectProperty(p) && propName(p) === 'rules');
    if (!rules || !t.isObjectProperty(rules) || !t.isArrayExpression(rules.value)) return;
    for (const rule of rules.value.elements) {
      if (!t.isObjectExpression(rule)) continue;
      for (const loaderName of extractLoaderNames(rule)) {
        if (/svg/.test(loaderName)) {
          flags.needsSvgr = true;
          warn('info', `SVG loader '${loaderName}' → use 'vite-plugin-svgr' (import SVGs as components via '?react'). Run: npm i -D vite-plugin-svgr`);
        } else if (/sass-loader|scss/.test(loaderName)) {
          flags.needsSass = true;
          warn('info', `'${loaderName}' → Vite handles Sass natively once you install the compiler. Run: npm i -D sass`);
        } else if (NATIVE_LOADERS.has(loaderName)) {
          warn('info', `'${loaderName}' is handled natively by Vite (esbuild/PostCSS). No loader needed.`);
        } else {
          flags.hasCustomLoaders = true;
          warn('manual', `Loader '${loaderName}' has no direct Vite equivalent. Find the matching Vite plugin or rework the asset/transform handling.`);
        }
      }
    }
  }

  function handlePlugins(arr: t.ArrayExpression) {
    for (const el of arr.elements) {
      const name = pluginName(el);
      if (!name) {
        flags.hasComplexPlugins = true;
        warn('verify', `A plugin entry could not be statically identified. Review it against the Vite plugin ecosystem manually.`);
        continue;
      }
      switch (name) {
        case 'HtmlWebpackPlugin':
          warn('info', `HtmlWebpackPlugin → Vite uses a root index.html as the entry; move your template there. No plugin needed.`);
          break;
        case 'DefinePlugin':
          definePresent.value = true;
          warn('verify', `DefinePlugin → Vite 'define'. Copy the replacement keys into the define block in the output.`);
          break;
        case 'MiniCssExtractPlugin':
          warn('info', `MiniCssExtractPlugin → CSS extraction is automatic in 'vite build'. Drop it.`);
          break;
        case 'CopyWebpackPlugin':
          warn('info', `CopyWebpackPlugin → put static files in 'public/', or use 'vite-plugin-static-copy' for custom targets.`);
          break;
        case 'ProvidePlugin':
          warn('manual', `ProvidePlugin (auto-imported globals) has no direct Vite equivalent. Use explicit imports, or 'vite-plugin-inject'.`);
          break;
        default:
          flags.hasComplexPlugins = true;
          warn('manual', `Plugin '${name}' was not classified. Check whether an equivalent Vite plugin exists or whether Vite handles it natively.`);
      }
    }
  }

  function handleDevServer(obj: t.ObjectExpression, out: string[]) {
    for (const p of obj.properties) {
      if (!t.isObjectProperty(p) || p.computed) continue;
      const k = propName(p);
      if (k === 'port') out.push(`port: ${generate(p.value).code}`);
      else if (k === 'open') out.push(`open: ${generate(p.value).code}`);
      else if (k === 'proxy') out.push(`proxy: ${generate(p.value).code} /* verify shape: Vite proxy mirrors http-proxy */`);
      else if (k === 'host') out.push(`host: ${generate(p.value).code}`);
      else warn('verify', `devServer.${k} may not map directly to Vite 'server'. Check the Vite server options.`);
    }
  }
}

// ---- parsing helpers ----

function parseInput(input: string): parser.ParseResult<t.File> | null {
  try {
    return parser.parse(input, { sourceType: 'unambiguous', plugins: ['typescript'] });
  } catch {
    return null;
  }
}

function findConfigObject(ast: parser.ParseResult<t.File>): t.ObjectExpression | null {
  let found: t.ObjectExpression | null = null;
  const unwrap = (node: t.Node | null | undefined): t.ObjectExpression | null => {
    if (!node) return null;
    if (t.isObjectExpression(node)) return node;
    // function-form: () => ({...}) or function() { return {...} }
    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) {
      if (t.isObjectExpression(node.body)) return node.body;
      if (t.isBlockStatement(node.body)) {
        const ret = node.body.body.find((s): s is t.ReturnStatement => t.isReturnStatement(s));
        if (ret && t.isObjectExpression(ret.argument)) return ret.argument;
      }
    }
    return null;
  };
  traverse(ast, {
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      if (found) return;
      const { left, right } = path.node;
      if (
        t.isMemberExpression(left) &&
        t.isIdentifier(left.object, { name: 'module' }) &&
        t.isIdentifier(left.property, { name: 'exports' })
      ) {
        found = unwrap(right);
      }
    },
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      if (found) return;
      found = unwrap(path.node.declaration as t.Node);
    },
  });
  return found;
}

function propName(p: t.ObjectProperty): string | null {
  if (t.isIdentifier(p.key)) return p.key.name;
  if (t.isStringLiteral(p.key)) return p.key.value;
  return null;
}

function extractLoaderNames(rule: t.ObjectExpression): string[] {
  const names: string[] = [];
  for (const p of rule.properties) {
    if (!t.isObjectProperty(p) || p.computed) continue;
    const k = propName(p);
    if (k === 'loader' && t.isStringLiteral(p.value)) names.push(p.value.value);
    if (k === 'use') collectUse(p.value as t.Node, names);
  }
  return names;
}

function collectUse(node: t.Node, names: string[]) {
  if (t.isStringLiteral(node)) names.push(node.value);
  else if (t.isArrayExpression(node)) {
    for (const el of node.elements) {
      if (t.isStringLiteral(el)) names.push(el.value);
      else if (t.isObjectExpression(el)) {
        const loader = el.properties.find((p) => t.isObjectProperty(p) && propName(p) === 'loader');
        if (loader && t.isObjectProperty(loader) && t.isStringLiteral(loader.value)) names.push(loader.value.value);
      }
    }
  } else if (t.isObjectExpression(node)) {
    const loader = node.properties.find((p) => t.isObjectProperty(p) && propName(p) === 'loader');
    if (loader && t.isObjectProperty(loader) && t.isStringLiteral(loader.value)) names.push(loader.value.value);
  }
}

function pluginName(node: t.Node | null): string | null {
  if (!node) return null;
  // `new SomePlugin(...)`
  if (t.isNewExpression(node) && t.isIdentifier(node.callee)) return node.callee.name;
  if (t.isNewExpression(node) && t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property)) {
    return node.callee.property.name;
  }
  return null;
}

// ---- output rendering ----

function render(parts: {
  resolveAlias: Array<[string, string]>;
  resolveExtensions: string[];
  serverLines: string[];
  definePresent: { value: boolean };
  flags: ConversionFlags;
}): string {
  const { resolveAlias, resolveExtensions, serverLines, definePresent, flags } = parts;
  const lines: string[] = [];
  lines.push(`import { defineConfig } from 'vite';`);
  if (flags.needsSvgr) lines.push(`import svgr from 'vite-plugin-svgr';`);
  lines.push(``);
  lines.push(`export default defineConfig({`);

  if (flags.needsSvgr) lines.push(`  plugins: [svgr()],`);
  if (definePresent.value) lines.push(`  define: { /* copy DefinePlugin replacement keys here */ },`);

  if (resolveAlias.length > 0 || resolveExtensions.length > 0) {
    lines.push(`  resolve: {`);
    if (resolveAlias.length > 0) {
      lines.push(`    alias: {`);
      for (const [k, v] of resolveAlias) lines.push(`      ${quoteKey(k)}: ${JSON.stringify(v)},`);
      lines.push(`    },`);
    }
    if (resolveExtensions.length > 0) {
      lines.push(`    extensions: [${resolveExtensions.map((e) => JSON.stringify(e)).join(', ')}],`);
    }
    lines.push(`  },`);
  }

  if (serverLines.length > 0) {
    lines.push(`  server: { ${serverLines.join(', ')} },`);
  }

  lines.push(`});`);
  lines.push(``);
  lines.push(`// Next steps:`);
  lines.push(`// 1. npm i -D vite`);
  if (flags.needsSvgr) lines.push(`// 2. npm i -D vite-plugin-svgr`);
  if (flags.needsSass) lines.push(`// 3. npm i -D sass`);
  lines.push(`// 4. Create an index.html entry at the project root (Vite's entry point).`);
  return lines.join('\n');
}

function quoteKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}
