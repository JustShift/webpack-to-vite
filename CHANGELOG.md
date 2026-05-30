# Changelog

<!--
  Keep an "## Unreleased" section at the top while work accumulates.
  At release time, rename it to "## <version> — <YYYY-MM-DD>" BEFORE tagging —
  the release workflow extracts that exact section for the GitHub Release notes.
-->

## Unreleased

## 0.1.0 — 2026-05-30

- Initial scaffold: AST-based Webpack config analyzer that emits a `vite.config.ts` skeleton plus a migration report.
- CLI `webpack-to-vite` (file/stdin, `--apply`, `--strict`, `--quiet`, `--json`, `--force`) and programmatic `analyzeWebpackConfig(source)`.
- Classifies `resolve`, `module.rules` loaders, well-known `plugins`, and `devServer`; emits tiered warnings for `mode`, `devtool`, `optimization`, `entry`, `output`, `externals`, `target`, and unknown loaders/plugins.
