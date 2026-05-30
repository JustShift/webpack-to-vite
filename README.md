# @shiftkit/webpack-to-vite

Analyze a Webpack config and map it to a Vite config. AST-based, with actionable warnings.

> **Status: early (0.1.x).** This is an **analyzer** — it parses `webpack.config.js`, classifies what maps cleanly to Vite, what needs a Vite plugin, and what needs manual work, and emits a `vite.config.ts` skeleton. It does not attempt a fully automatic, drop-in conversion (Webpack's loader/plugin surface is too large for that to be safe). It tells you exactly where the work is.

Part of [ShiftKit](https://github.com/JustShift) — one focused, AST-based migration tool per migration.

## Install

```bash
npm i -D @shiftkit/webpack-to-vite
# or:
npx @shiftkit/webpack-to-vite webpack.config.js
```

## Usage

```bash
# print the vite.config.ts skeleton + report
webpack-to-vite webpack.config.js

# pipe via stdin
cat webpack.config.js | webpack-to-vite

# write vite.config.ts to disk (auto-detects webpack.config.*; refuses on a dirty tree)
webpack-to-vite --apply
```

Options: `--strict`, `--quiet`, `--json`, `--apply`, `--force`. See `--help`.

## Programmatic API

```ts
import { analyzeWebpackConfig } from '@shiftkit/webpack-to-vite';

const { output, warnings, flags } = analyzeWebpackConfig(webpackConfigSource);
```

## What it classifies today

| Webpack | Vite |
|---|---|
| `resolve.alias` | `resolve.alias` (string targets) |
| `resolve.extensions` | `resolve.extensions` |
| `module.rules` loaders | `babel/ts/css/postcss/file/url/raw` → native; `sass-loader` → install `sass`; `*svg*` → `vite-plugin-svgr`; unknown → manual |
| `plugins` | `HtmlWebpackPlugin`/`MiniCssExtractPlugin`/`CopyWebpackPlugin` → native/built-in; `DefinePlugin` → `define`; unknown → manual |
| `devServer` | `server` (port, open, host, proxy) |
| `mode`, `devtool`, `optimization`, `entry`, `output`, `externals`, `target` | mapped with a verify/manual note |

## License

Apache-2.0
