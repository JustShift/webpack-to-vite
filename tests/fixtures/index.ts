import type { AnalyzeOptions, ConversionFlags, WarningCode } from '../../src/types';
import type { Confidence } from '../../src/confidence';

export interface Fixture {
  name: string;
  /** The webpack config source. */
  input: string;
  options?: AnalyzeOptions;
  /** Warning codes that MUST appear (others may also appear). */
  expectCodes: WarningCode[];
  /** Warning codes that MUST NOT appear. */
  forbidCodes?: WarningCode[];
  /** Flags that must equal these values. */
  expectFlags?: Partial<ConversionFlags>;
  /** Substrings that must appear in the rendered output. */
  expectOutputIncludes?: string[];
  /** Substrings that must NOT appear in the rendered output. */
  expectOutputExcludes?: string[];
  expectConfidence?: Confidence;
}

// Minimum v0.1 release-gate fixtures (12) + stretch fixtures.
export const FIXTURES: Fixture[] = [
  {
    name: 'fx-minimal',
    input: `
      const path = require('path');
      module.exports = {
        mode: 'production',
        entry: './src/index.js',
        output: {
          path: path.resolve(__dirname, 'dist'),
          filename: 'bundle.js',
        },
      };
    `,
    expectCodes: ['config.mode', 'entry.mapped', 'output.outDir', 'output.naming'],
    expectOutputIncludes: ["outDir: 'dist'", 'rolldownOptions', "input: './src/index.js'"],
    expectConfidence: 'Verify before merging',
  },
  {
    name: 'fx-alias',
    input: `
      const path = require('path');
      module.exports = {
        resolve: {
          alias: {
            '@': path.resolve(__dirname, 'src'),
            'react$': path.resolve(__dirname, 'node_modules/react'),
            components: './src/components',
          },
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
      };
    `,
    expectCodes: ['resolve.alias', 'resolve.aliasExact', 'resolve.dirnameEsm', 'resolve.extensions'],
    expectOutputIncludes: [
      "import path from 'node:path';",
      "{ find: '@', replacement: path.resolve(__dirname, 'src') }",
      'find: /^react$/',
      "{ find: 'components', replacement: './src/components' }",
    ],
    // Two non-high-risk verify warnings (dirnameEsm, aliasExact) → High confidence.
    expectConfidence: 'High confidence',
  },
  {
    name: 'fx-svg-assets',
    input: `
      module.exports = {
        module: {
          rules: [
            { test: /\\.svg$/, use: ['@svgr/webpack'] },
            { test: /\\.(png|jpg)$/, use: ['file-loader'] },
            { test: /\\.css$/, use: ['style-loader', 'css-loader'] },
          ],
        },
      };
    `,
    // @svgr/webpack is a strong React signal, so the framework plugin is wired in too.
    expectCodes: ['module.svgr', 'module.assetLoader', 'module.nativeLoader', 'framework.plugin'],
    expectFlags: { needsSvgr: true, hasCustomLoaders: false },
    expectOutputIncludes: [
      "import svgr from 'vite-plugin-svgr';",
      "import react from '@vitejs/plugin-react';",
      'react()',
      'svgr()',
    ],
  },
  {
    name: 'fx-env-define',
    input: `
      const webpack = require('webpack');
      module.exports = {
        plugins: [
          new webpack.DefinePlugin({
            'process.env.API_URL': JSON.stringify('https://api.example.com'),
            __APP_VERSION__: JSON.stringify('1.0.0'),
          }),
        ],
      };
    `,
    expectCodes: ['plugin.define', 'plugin.defineEnv'],
    expectFlags: { hasProcessEnvSource: true },
    expectOutputIncludes: [
      'define: {',
      "__APP_VERSION__: JSON.stringify('1.0.0')",
      'compatibility shim',
    ],
    expectConfidence: 'Manual review required',
  },
  {
    name: 'fx-multipage',
    input: `
      module.exports = {
        entry: {
          main: './src/main.js',
          admin: './src/admin.js',
        },
      };
    `,
    expectCodes: ['entry.multiPage'],
    expectFlags: { hasMultiEntry: true },
    expectOutputIncludes: ["main: './src/main.js'", "admin: './src/admin.js'"],
  },
  {
    name: 'fx-commonjs-dep',
    input: `module.exports = {};`,
    options: {
      sourceFiles: [
        { path: 'src/legacy.js', content: "const lodash = require('lodash');\nmodule.exports = { legacy: true };" },
      ],
    },
    expectCodes: ['source.require'],
    expectFlags: { hasCommonJsSource: true, hasCommonJsDependencies: true },
  },
  {
    name: 'fx-require-context',
    input: `module.exports = {};`,
    options: {
      sourceFiles: [
        { path: 'src/registry.js', content: "const ctx = require.context('./components', true, /\\.js$/);" },
      ],
    },
    expectCodes: ['source.requireContext'],
    expectFlags: { hasRequireContext: true },
    expectConfidence: 'Manual review required',
  },
  {
    name: 'fx-worker',
    input: `
      module.exports = {
        module: {
          rules: [
            { test: /\\.worker\\.js$/, use: ['worker-loader'] },
          ],
        },
      };
    `,
    expectCodes: ['module.workerLoader'],
    expectFlags: { hasWebWorkers: true },
    expectConfidence: 'Manual review required',
  },
  {
    name: 'fx-proxy',
    input: `
      module.exports = {
        devServer: {
          port: 3000,
          proxy: {
            '/api': {
              target: 'http://localhost:8080',
              changeOrigin: true,
              pathRewrite: { '^/api': '' },
            },
          },
        },
      };
    `,
    expectCodes: ['devServer.basic', 'devServer.proxy', 'devServer.proxyRewrite'],
    expectFlags: { hasProxyRewrite: true },
    expectOutputIncludes: [
      'server: {',
      'port: 3000',
      "target: 'http://localhost:8080'",
      'rewrite: (p) => p.replace(',
    ],
  },
  {
    name: 'fx-splitchunks',
    input: `
      module.exports = {
        optimization: {
          splitChunks: { chunks: 'all' },
          runtimeChunk: 'single',
        },
      };
    `,
    expectCodes: ['optimization.splitChunks', 'vite8.note'],
    expectFlags: { hasSplitChunks: true },
    expectOutputIncludes: ['codeSplitting', 'Vite 8 note:'],
    expectConfidence: 'Verify before merging',
  },
  {
    name: 'fx-function-form',
    input: `
      module.exports = (env, argv) => ({
        mode: argv.mode,
        entry: './src/index.js',
      });
    `,
    expectCodes: ['config.functionForm', 'config.dynamic', 'entry.mapped', 'config.mode'],
    expectConfidence: 'Manual review required',
  },
  {
    name: 'fx-plugins',
    input: `
      const HtmlWebpackPlugin = require('html-webpack-plugin');
      const MiniCssExtractPlugin = require('mini-css-extract-plugin');
      const CopyWebpackPlugin = require('copy-webpack-plugin');
      module.exports = {
        plugins: [
          new HtmlWebpackPlugin({ template: './public/index.html' }),
          new MiniCssExtractPlugin(),
          new CopyWebpackPlugin({ patterns: [{ from: 'static' }] }),
        ],
      };
    `,
    expectCodes: ['plugin.html', 'plugin.miniCss', 'plugin.copy'],
    expectFlags: { hasHtmlPlugin: true, needsStaticCopy: true },
  },

  {
    name: 'fx-module-federation',
    input: `
      const { ModuleFederationPlugin } = require('webpack').container;
      module.exports = {
        plugins: [
          new ModuleFederationPlugin({
            name: 'host',
            remotes: { mfe: 'mfe@http://localhost:3001/remoteEntry.js' },
            shared: ['react', 'react-dom'],
          }),
        ],
      };
    `,
    expectCodes: ['plugin.federation'],
    expectFlags: { hasModuleFederation: true },
    expectConfidence: 'Manual review required',
  },
  {
    name: 'fx-css-modules',
    input: `
      module.exports = {
        module: {
          rules: [
            {
              test: /\\.css$/,
              use: ['style-loader', { loader: 'css-loader', options: { modules: { localIdentName: '[name]__[local]' } } }],
            },
          ],
        },
      };
    `,
    expectCodes: ['module.cssModulesNaming', 'module.nativeLoader'],
    expectFlags: { usesCssModulesWithoutModuleSuffix: true },
    expectConfidence: 'Verify before merging',
  },
  {
    name: 'fx-alias-array-value',
    input: `module.exports = { resolve: { alias: { '@': ['./src', './lib'] } } };`,
    expectCodes: ['resolve.aliasArrayValue'],
    expectOutputExcludes: ["find: '@'"],
  },
  {
    name: 'fx-html-plugin',
    input: `
      const HtmlWebpackPlugin = require('html-webpack-plugin');
      module.exports = { plugins: [new HtmlWebpackPlugin({ template: './src/index.html' })] };
    `,
    expectCodes: ['plugin.html'],
    expectFlags: { hasHtmlPlugin: true },
  },

  // ---- stretch fixtures ----
  {
    name: 'fx-node-globals',
    input: `
      const webpack = require('webpack');
      module.exports = {
        plugins: [
          new webpack.ProvidePlugin({ Buffer: ['buffer', 'Buffer'], process: 'process/browser' }),
        ],
      };
    `,
    expectCodes: ['plugin.provide'],
    expectFlags: { needsNodePolyfills: true },
    expectConfidence: 'Manual review required',
  },
  {
    name: 'fx-framework-cra',
    input: `
      // ejected from react-scripts
      module.exports = { mode: 'production', entry: './src/index.tsx' };
    `,
    expectCodes: ['framework.cra'],
    expectFlags: { hasFrameworkSpecificWebpack: true },
  },
];
