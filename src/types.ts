/**
 * Public + internal types for @shiftkit/webpack-to-vite.
 *
 * This package is an *analyzer*, not a one-click converter. It emits a
 * Vite-8-oriented `vite.config.ts` skeleton, a tiered migration report, and a
 * dependency checklist — and it never claims that source-code or architectural
 * migration is complete. Output is deterministic and produced by parsing the
 * webpack config statically (Babel AST). The user config is never executed:
 * no `eval`, no `new Function`, no `require()` of the config, no calling
 * exported config functions.
 */

export type WarningType = 'manual' | 'verify' | 'info';

/**
 * Stable warning codes. The first block is the documented public contract; the
 * second ("analyzer plumbing") block covers config-level and catch-all cases
 * the contract list does not name. Keeping these as explicit codes — rather
 * than mis-tagging with a near-miss code or dropping the warning — keeps the
 * confidence band and snapshot tests honest.
 */
export type WarningCode =
  // entry
  | 'entry.mapped'
  | 'entry.multiPage'
  | 'entry.dynamic'
  // output
  | 'output.outDir'
  | 'output.naming'
  | 'output.publicPath'
  | 'output.library'
  // resolve
  | 'resolve.alias'
  | 'resolve.aliasExact'
  | 'resolve.aliasArrayValue'
  | 'resolve.dirnameEsm'
  | 'resolve.tsconfigPaths'
  | 'resolve.fallback'
  // module / loaders
  | 'module.nativeLoader'
  | 'module.preprocessor'
  | 'module.cssModulesNaming'
  | 'module.svgr'
  | 'module.assetLoader'
  | 'module.workerLoader'
  | 'module.customLoader'
  // plugins
  | 'plugin.html'
  | 'plugin.define'
  | 'plugin.defineEnv'
  | 'plugin.copy'
  | 'plugin.provide'
  | 'plugin.miniCss'
  | 'plugin.checker'
  | 'plugin.compression'
  | 'plugin.visualizer'
  | 'plugin.federation'
  | 'plugin.benign'
  // dev server
  | 'devServer.basic'
  | 'devServer.proxy'
  | 'devServer.proxyRewrite'
  | 'devServer.https'
  // devtool
  | 'devtool.sourcemap'
  // optimization
  | 'optimization.splitChunks'
  // externals
  | 'externals.detected'
  // target
  | 'target.ssr'
  // source scanning (optional, only when sourceFiles provided)
  | 'source.require'
  | 'source.requireContext'
  | 'source.processEnv'
  | 'source.worker'
  | 'source.moduleHot'
  // frameworks
  | 'framework.cra'
  | 'framework.plugin'
  // vite 8 bookkeeping
  | 'vite8.note'
  // ---- analyzer plumbing (not in the documented list, but required) ----
  | 'config.parseError'
  | 'config.notFound'
  | 'config.dynamic'
  | 'config.functionForm'
  | 'config.multiConfig'
  | 'config.merge'
  | 'config.mode'
  | 'config.unmapped'
  | 'resolve.modules'
  | 'resolve.extensions'
  | 'module.unknownRule'
  | 'plugin.unknown'
  | 'target.web';

export type Warning = {
  type: WarningType;
  code: WarningCode;
  message: string;
  path?: string;
};

export type ConversionFlags = {
  needsSvgr: boolean;
  needsSass: boolean;
  needsLess: boolean;
  needsStylus: boolean;
  needsTsconfigPaths: boolean;
  needsNodePolyfills: boolean;
  needsStaticCopy: boolean;
  needsChecker: boolean;
  needsVisualizer: boolean;
  needsCompression: boolean;

  hasCustomLoaders: boolean;
  hasComplexPlugins: boolean;
  hasModuleFederation: boolean;
  hasWebWorkers: boolean;
  hasRequireContext: boolean;
  hasCommonJsSource: boolean;
  hasCommonJsDependencies: boolean;
  hasProcessEnvSource: boolean;
  hasExternals: boolean;
  hasSplitChunks: boolean;
  hasMultiEntry: boolean;
  hasHtmlPlugin: boolean;
  hasProxyRewrite: boolean;
  hasFrameworkSpecificWebpack: boolean;
  usesCssModulesWithoutModuleSuffix: boolean;

  targetViteMajor: 7 | 8;
};

export type DependencySuggestion = {
  name: string;
  reason: string;
  required: boolean;
  caution?: string;
};

export type ConversionResult = {
  output: string;
  warnings: Warning[];
  flags: ConversionFlags;
  dependencies: DependencySuggestion[];
};

export type AnalyzeOptions = {
  strict?: boolean;
  targetViteMajor?: 7 | 8;
  sourceFiles?: Array<{ path: string; content: string }>;
};

export type ResolvedOptions = {
  strict: boolean;
  targetViteMajor: 7 | 8;
  sourceFiles: Array<{ path: string; content: string }>;
};

export const DEFAULT_TARGET_VITE_MAJOR: 7 | 8 = 8;

// ---------------------------------------------------------------------------
// Intermediate model. Handlers never render strings directly — they populate
// this model, and render(model, target) decides the final shape (rolldownOptions
// for Vite 8, rollupOptions for Vite 7).
// ---------------------------------------------------------------------------

export type AliasEntry = {
  /** Rendered `find` source: a quoted string for prefix aliases, or a regex
   *  literal (e.g. `/^react$/`) for webpack `$`-suffixed exact aliases. */
  find: string;
  /** Rendered `replacement` source: a string literal or a `path.resolve(...)`
   *  expression. */
  replacement: string;
};

export type DefineEntry = {
  /** Rendered value source, e.g. `JSON.stringify('1.0.0')`. */
  value: string;
  /** Optional trailing line comment (e.g. compatibility-shim note). */
  comment?: string;
};

export type ViteModel = {
  /** Full import statements, deduped, e.g. `import svgr from 'vite-plugin-svgr';` */
  imports: Set<string>;
  /** Plugin call expressions in order, e.g. `svgr()`. */
  plugins: string[];
  /** Insertion-ordered define map keyed by the (already-quoted-if-needed) key. */
  define: Map<string, DefineEntry>;
  resolve: {
    alias: AliasEntry[];
    extensions?: string[];
    tsconfigPaths?: boolean;
  };
  server: {
    host?: string;
    port?: string;
    open?: string;
    https?: string;
    /** Rendered proxy object source. */
    proxy?: string;
  };
  build: {
    outDir?: string;
    /** Rendered sourcemap value: `true`, `'inline'`, `'hidden'`, or `false`. */
    sourcemap?: string;
    /** Rendered input value: a string literal or an object map source. */
    input?: string;
    /** Rendered entryFileNames value (kept as a hint/comment). */
    entryFileNames?: string;
    /** Rendered chunkFileNames value (kept as a hint/comment). */
    chunkFileNames?: string;
    /** Rendered `base` value (from output.publicPath). */
    base?: string;
    /** True when splitChunks was present and a codeSplitting stub should be emitted. */
    codeSplittingNote?: boolean;
  };
  /** Free-form `// MANUAL:`-style lines to drop into the build block. */
  buildNotes: string[];
  /** Whether the Vite 8 migration note block should be emitted. */
  vite8NoteNeeded: boolean;
};

export function emptyModel(): ViteModel {
  return {
    imports: new Set<string>(),
    plugins: [],
    define: new Map<string, DefineEntry>(),
    resolve: { alias: [] },
    server: {},
    build: {},
    buildNotes: [],
    vite8NoteNeeded: false,
  };
}

export function emptyFlags(targetViteMajor: 7 | 8): ConversionFlags {
  return {
    needsSvgr: false,
    needsSass: false,
    needsLess: false,
    needsStylus: false,
    needsTsconfigPaths: false,
    needsNodePolyfills: false,
    needsStaticCopy: false,
    needsChecker: false,
    needsVisualizer: false,
    needsCompression: false,

    hasCustomLoaders: false,
    hasComplexPlugins: false,
    hasModuleFederation: false,
    hasWebWorkers: false,
    hasRequireContext: false,
    hasCommonJsSource: false,
    hasCommonJsDependencies: false,
    hasProcessEnvSource: false,
    hasExternals: false,
    hasSplitChunks: false,
    hasMultiEntry: false,
    hasHtmlPlugin: false,
    hasProxyRewrite: false,
    hasFrameworkSpecificWebpack: false,
    usesCssModulesWithoutModuleSuffix: false,

    targetViteMajor,
  };
}

/**
 * Analyzer context threaded through every handler. Handlers mutate `model` and
 * `flags` and emit warnings via the tier helpers.
 */
export interface AnalyzerContext {
  model: ViteModel;
  flags: ConversionFlags;
  options: ResolvedOptions;
  /** Dependency suggestions not derivable from flags alone (e.g. framework plugin). */
  extraDependencies: DependencySuggestion[];
  manual: (code: WarningCode, message: string, path?: string) => void;
  verify: (code: WarningCode, message: string, path?: string) => void;
  info: (code: WarningCode, message: string, path?: string) => void;
}
