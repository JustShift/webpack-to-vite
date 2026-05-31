# Changelog

<!--
  Keep an "## Unreleased" section at the top while work accumulates.
  At release time, rename it to "## <version> — <YYYY-MM-DD>" BEFORE tagging —
  the release workflow extracts that exact section for the GitHub Release notes.
-->

## Unreleased

## 0.1.0 — 2026-05-31

- Vite 8-first Webpack → Vite migration analyzer with a parse → static-eval → intermediate-model → render pipeline. Static AST only, so your webpack config is never executed.
  - **Vite 8 default output** (`build.rolldownOptions`, built-in `resolve.tsconfigPaths`); `targetViteMajor: 7` falls back to `build.rollupOptions` + the `vite-tsconfig-paths` plugin.
  - Stable `WarningCode`s on every warning; confidence band (`getConfidence`) and raw tier counts (`tierCounts`); dependency checklist (`buildDependencies`) on the result.
  - Handlers for `resolve` (array-form alias, `name$` → exact regex, `__dirname` ESM note, array-value guard), loaders (native/asset/preprocessor/svgr/worker/custom + CSS-Modules-naming detection), plugins (`DefinePlugin` extraction with `process.env` shim, Html/Copy/Provide/checker/compression/visualizer, `ModuleFederationPlugin` hard stop), `devServer` proxy (+ `pathRewrite` → `rewrite` fn), `entry`, `output`, `devtool`, `optimization.splitChunks`, `externals`, `target`.
  - Function-form configs are read without executing them; env/argv dependence is flagged. `webpack-merge` is detected (only the static layer is analyzed).
  - Framework detection wires the matching `@vitejs/plugin-react` / `-vue` / svelte / solid plugin into the output and dependency list; `DefinePlugin process.env.NODE_ENV` is dropped (Vite sets it).
  - Optional, opt-in source scan (`sourceFiles` / `--source`) for `require`, `require.context`, dynamic `import()`, `process.env`, web workers, and `module.hot`.
  - CLI: `--json`, `--strict`, `--target-vite`, `--source`, `--apply --out` (writes config + JSON report only; never mutates `package.json`). GitHub Action with `input`/`target-vite`/`out`/`source` inputs.
- 18 fixtures (12 release-gate + module-federation/css-modules/alias-array-value/html-plugin + stretch) with exact tier/code snapshots, flag assertions, valid-TS output checks, a source-level no-eval/no-`new Function` gate, and CLI `--json`/`--strict` tests.
