# Changelog

<!--
  Keep an "## Unreleased" section at the top while work accumulates.
  At release time, rename it to "## <version> — <YYYY-MM-DD>" BEFORE tagging —
  the release workflow extracts that exact section for the GitHub Release notes.
-->

## Unreleased

## 0.3.0 — 2026-06-13

- `output.library`/`libraryTarget` — previously dropped without a word — now emits a real `build.lib` block (entry from the detected webpack entry, `name`, and `formats` mapped from `umd`→`umd`, `module`→`es`, `commonjs*`→`cjs`, `var`/`window`/…→`iife`) with a verify warning. Unknown library types fall back to a manual warning.
- Unknown keys inside `resolve`, `output`, and `module` (e.g. `resolve.mainFields`, `output.assetModuleFilename`, `module.noParse`) now emit named `resolve.unmapped`/`output.unmapped`/`module.unmapped` warnings instead of being dropped in silence — the systemic fix for the audit's silent-drop bug class. `resolve.symlinks` points at Vite's inverse `preserveSymlinks`; benign keys (`output.pathinfo`, `module.strictExportPresence`, …) report as info.
- Static `sass-loader`/`less-loader`/`stylus-loader` options (`additionalData`, `prependData`, flattened `sassOptions`/`lessOptions`/`stylusOptions`) are now emitted as a `css.preprocessorOptions.<lang>` block instead of only a warning telling you to move them. `implementation`/`sourceMap`-style webpack-only options are dropped.
- `entry: path.resolve(__dirname, 'src/index.js')` (and `path.resolve` values inside object/array entries) is now statically evaluated and mapped instead of falling to the manual `entry.dynamic` warning.
- `HtmlWebpackPlugin` now produces a ready-to-paste `index.html` skeleton (module script tag pointing at the detected entry; `title`/`favicon`/`template` read statically). It is returned as `result.indexHtml` and written next to the config by `--apply` when no `index.html` exists.
- `devServer.static`/`contentBase` with a static string or `{ directory }` value now emits `publicDir` directly instead of only describing the mapping.
- New real-project fixture suite (`tests/real-fixtures.test.ts`): ejected CRA, vue-cli base, webpack 5 asset modules, a UMD library build, and a webpack-merge prod config, each snapshotting the full rendered output, the migration report, and the dependency checklist.
- CLI: new `--deps` flag (with `--apply`) opts in to updating `package.json` — it adds the *required* dependencies from the checklist to devDependencies and never removes anything. Without `--deps`, `package.json` is untouched as before. This resolves the documented asymmetry with `@shiftkit/jest-to-vitest --apply`.
- Section values are no longer dropped silently. `plugins: [...].filter(Boolean)` and `[...].concat(cond ? [...] : [])` are unwrapped to the underlying array literal, conditional plugin elements (`cond && new X()`, ternaries) are classified on both branches, and any `plugins`/`output`/`resolve`/`module`/`devServer`/`optimization` value that cannot be read statically now emits a manual `config.dynamic` warning instead of nothing. Previously a config using these idioms converted to an empty skeleton rated "High confidence".
- webpack 5 asset modules (`type: 'asset/resource'` etc.) are now recognized: `asset/resource` and `asset` report as natively handled (info), `asset/inline` and `asset/source` flag the `?inline`/`?raw` import-shape changes (verify). Previously these rules were invisible.
- `resolve.fallback` now sets `needsNodePolyfills`, emits a manual `resolve.fallback` warning, and suggests `vite-plugin-node-polyfills`. Previously a Node-polyfill config converted to an empty skeleton with no warnings.
- Exact-match aliases containing `/` (e.g. `'@app/core$'`) no longer render a syntactically invalid regex literal; slashes are escaped in the generated `find` pattern.
- `devServer.https`/`devServer.server` mapping rewritten: boolean `https: true` is no longer emitted (Vite's `server.https` takes `https.createServer()` options; `@vitejs/plugin-basic-ssl` is suggested instead, new `devServer.https` code), cert-option objects are copied through, and `server: 'http'` is dropped instead of being converted into an HTTPS dev server.
- `output.path` keeps nested directories (`build/static`) instead of only the last segment; absolute paths fall back to the last segment with a verify warning.
- Array entries now use the last element as the build input (webpack exports the last; earlier ones are usually polyfills). Previously the first element was used.
- `vue-loader`/`VueLoaderPlugin` (and `svelte-loader`) are classified as replaced by the framework plugin the analyzer already wires in, instead of producing contradictory manual warnings on every standard Vue config.
- Multi-config arrays now emit `config.multiConfig` instead of the mis-tagged `config.functionForm`.
- CLI: absolute file paths work for the positional argument and `--out` (previously mangled by `join(cwd, ...)`).

## 0.2.0 — 2026-06-11

- Vite 8-first Webpack → Vite migration analyzer with a parse → static-eval → intermediate-model → render pipeline. Static AST only, so your webpack config is never executed.
  - **Vite 8 default output** (`build.rolldownOptions`, built-in `resolve.tsconfigPaths`); `targetViteMajor: 7` falls back to `build.rollupOptions` + the `vite-tsconfig-paths` plugin.
  - Stable `WarningCode`s on every warning; confidence band (`getConfidence`) and raw tier counts (`tierCounts`); dependency checklist (`buildDependencies`) on the result.
  - Handlers for `resolve` (array-form alias, `name$` → exact regex, `__dirname` ESM note, array-value guard), loaders (native/asset/preprocessor/svgr/worker/custom + CSS-Modules-naming detection), plugins (`DefinePlugin` extraction with `process.env` shim, Html/Copy/Provide/checker/compression/visualizer, `ModuleFederationPlugin` hard stop), `devServer` proxy (+ `pathRewrite` → `rewrite` fn), `entry`, `output`, `devtool`, `optimization.splitChunks`, `externals`, `target`.
  - Function-form configs are read without executing them; env/argv dependence is flagged. `webpack-merge` is detected (only the static layer is analyzed).
  - Framework detection wires the matching `@vitejs/plugin-react` / `-vue` / svelte / solid plugin into the output and dependency list; `DefinePlugin process.env.NODE_ENV` is dropped (Vite sets it).
  - Optional, opt-in source scan (`sourceFiles` / `--source`) for `require`, `require.context`, dynamic `import()`, `process.env`, web workers, and `module.hot`.
  - CLI: `--json`, `--strict`, `--target-vite`, `--source`, `--apply --out` (writes config + JSON report only; never mutates `package.json`). GitHub Action with `input`/`target-vite`/`out`/`source` inputs.
- 18 fixtures (12 release-gate + module-federation/css-modules/alias-array-value/html-plugin + stretch) with exact tier/code snapshots, flag assertions, valid-TS output checks, a source-level no-eval/no-`new Function` gate, and CLI `--json`/`--strict` tests.
