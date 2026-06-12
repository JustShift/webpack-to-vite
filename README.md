# @shiftkit/webpack-to-vite

Analyze a Webpack config and map it to a **Vite 8**-oriented `vite.config.ts`. AST-based, deterministic, with tiered, actionable warnings.

> **Status: early (0.1.x).** This is an **analyzer**, not a one-click converter. It parses `webpack.config.js` statically (Babel AST, so your config is **never executed**), emits a `vite.config.ts` skeleton, a tiered migration report, and a dependency checklist. It does *not* claim to migrate source code or architecture. Webpack's loader/plugin surface is too large for that to be safe. It tells you exactly where the work is.

Part of [ShiftKit](https://github.com/JustShift): one focused, AST-based migration tool per migration.

## Install

```bash
npm i -D @shiftkit/webpack-to-vite
# or run once:
npx @shiftkit/webpack-to-vite webpack.config.js
```

## Usage

```bash
# print the vite.config.ts skeleton; the report goes to stderr
webpack-to-vite webpack.config.js

# machine-readable result
webpack-to-vite webpack.config.js --json

# fail CI when anything needs manual work
webpack-to-vite webpack.config.js --strict

# write vite.config.ts + shiftkit-webpack-to-vite-report.json
# (+ an index.html skeleton when HtmlWebpackPlugin was detected and none exists)
webpack-to-vite webpack.config.js --apply --out vite.config.ts

# additionally add the REQUIRED dependencies from the checklist to
# package.json devDependencies (opt-in; nothing is ever removed)
webpack-to-vite webpack.config.js --apply --deps

# target Vite 7 (rollupOptions + vite-tsconfig-paths) instead of the Vite 8 default
webpack-to-vite webpack.config.js --target-vite 7

# (advanced) also scan source for migration traps (require.context, process.env, workers…)
webpack-to-vite webpack.config.js --source "src/**/*.{js,jsx,ts,tsx}"
```

See `--help` for all flags. `--apply` refuses to run on a dirty tree / outside a git repo unless `--force`, never deletes your webpack config, and never touches `package.json` unless you opt in with `--deps` (which only *adds* the required devDependencies — it never removes anything; the analyzer cannot know which webpack packages are still in use).

## Programmatic API

```ts
import { analyzeWebpackConfig, getConfidence } from '@shiftkit/webpack-to-vite';

const result = analyzeWebpackConfig(webpackConfigSource, {
  targetViteMajor: 8,        // default; 7 for the rollupOptions/plugin fallback
  // sourceFiles: [{ path, content }],  // optional source scan
});

result.output;        // vite.config.ts skeleton (string)
result.warnings;      // { type, code, message, path? }[]
result.flags;         // detection flags (needsSvgr, hasModuleFederation, …)
result.dependencies;  // { name, reason, required, caution? }[]
result.indexHtml;     // ready-to-paste index.html skeleton (when HtmlWebpackPlugin was detected)
getConfidence(result.warnings); // 'High confidence' | 'Verify before merging' | 'Manual review required'
```

### Warning tiers

| Tier | Meaning |
|---|---|
| `info` | Bookkeeping / dropped because Vite handles it natively. |
| `verify` | Mapped or suggested, but behavior may differ. Check it. |
| `manual` | Cannot be safely mapped from config alone. |

Each warning carries a stable `code` (e.g. `resolve.aliasExact`, `plugin.federation`, `entry.multiPage`) so reports are snapshot-testable and machine-filterable. Confidence is reported as raw counts (e.g. `2 manual · 4 verify · 6 info`), never a fake percentage.

## What it maps today

| Webpack | Vite | Tier |
|---|---|---|
| `resolve.alias` (string / `path.resolve`) | `resolve.alias` array form | auto / verify |
| `resolve.alias` `name$` (exact) | `{ find: /^name$/, … }` | verify |
| `resolve.extensions` | `resolve.extensions` | info |
| `tsconfig-paths` coupling | `resolve.tsconfigPaths: true` (Vite 8) / `vite-tsconfig-paths` (Vite 7) | verify |
| `babel/ts/css/style/postcss` loaders | dropped (native) | info |
| `file/url/raw` loaders | dropped; `?url` / `?raw` import suffixes | verify |
| `sass/less/stylus` loaders | install the compiler; static loader options → `css.preprocessorOptions` | verify |
| `@svgr/webpack` | `vite-plugin-svgr` (`?react`) | verify |
| `worker-loader` | `?worker` import suffix | manual |
| `DefinePlugin` | `define` (+ `process.env` shim → `import.meta.env`; `NODE_ENV` dropped) | verify / manual |
| React / Vue / Svelte / Solid signal | matching `@vitejs/plugin-*` wired into `plugins` | verify |
| `HtmlWebpackPlugin` | generated root `index.html` skeleton (entry/title/favicon read statically) | verify |
| `Copy` / `MiniCssExtract` / `ProvidePlugin` / checkers / compression / analyzer | publicDir / native / plugins | info / verify / manual |
| `ModuleFederationPlugin` | hard stop (architecture) | manual |
| `devServer` (port/host/open/https/proxy + `pathRewrite`) | `server` | info / verify |
| `devServer.static` / `contentBase` (static values) | `publicDir` | verify |
| `entry` (string / object / array / `path.resolve(...)` / fn) | `build.*Options.input` (HTML-first) | verify / manual |
| `output` (path / publicPath / filename) | `outDir` / `base` / naming hints | info / verify |
| `output.library` / `libraryTarget` | `build.lib` (`umd`→`umd`, `module`→`es`, `commonjs*`→`cjs`) | verify |
| unrecognized keys inside `resolve` / `output` / `module` | named warning (nothing is dropped silently) | manual |
| `devtool` | `build.sourcemap` | info / verify |
| `optimization.splitChunks` | Rolldown `codeSplitting` stub | verify |
| `externals`, non-web `target` | manual | manual |

Vite 8 is the default output (`build.rolldownOptions`, built-in tsconfig paths); pass `targetViteMajor: 7` for the `build.rollupOptions` + plugin fallback.

## Trust

Deterministic, runs locally, and **never executes your config**: no `eval`, no `new Function`, no `require()` of the config, no calling exported config functions. Same input, same output.

## License

Apache-2.0
