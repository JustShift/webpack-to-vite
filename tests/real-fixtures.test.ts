import { describe, it, expect } from 'vitest';
import { analyzeWebpackConfig } from '../src/converter';
import { getConfidence } from '../src/confidence';

/**
 * Real-project fixture suite. These are condensed but structurally faithful
 * versions of configs real projects ship (ejected CRA, vue-cli, webpack 5
 * asset modules, a UMD library build, a webpack-merge pair). The full rendered
 * output and the warning report are snapshotted: any silent drop or output
 * regression shows up as a snapshot diff.
 */

const REAL_FIXTURES: Array<{ name: string; input: string }> = [
  {
    // Ejected create-react-app webpack.config.js (representative subset of the
    // real ~750-line file: oneOf rules, babel-loader, css modules, svgr,
    // InterpolateHtmlPlugin-style DefinePlugin usage).
    name: 'cra-ejected',
    input: `
      'use strict';
      const path = require('path');
      const webpack = require('webpack');
      const HtmlWebpackPlugin = require('html-webpack-plugin');
      const MiniCssExtractPlugin = require('mini-css-extract-plugin');
      const CaseSensitivePathsPlugin = require('case-sensitive-paths-webpack-plugin');
      const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
      const isEnvProduction = process.env.NODE_ENV === 'production';

      module.exports = {
        mode: isEnvProduction ? 'production' : 'development',
        bail: isEnvProduction,
        devtool: 'source-map',
        entry: path.resolve(__dirname, 'src/index.tsx'),
        output: {
          path: path.resolve(__dirname, 'build'),
          filename: 'static/js/[name].[contenthash:8].js',
          chunkFilename: 'static/js/[name].[contenthash:8].chunk.js',
          publicPath: '/',
        },
        resolve: {
          extensions: ['.web.mjs', '.mjs', '.web.js', '.js', '.web.ts', '.ts', '.web.tsx', '.tsx', '.json', '.web.jsx', '.jsx'],
          alias: {
            'react-native': 'react-native-web',
            src: path.resolve(__dirname, 'src'),
          },
        },
        module: {
          strictExportPresence: true,
          rules: [
            {
              oneOf: [
                {
                  test: [/\\.avif$/, /\\.bmp$/, /\\.gif$/, /\\.jpe?g$/, /\\.png$/],
                  type: 'asset',
                  parser: { dataUrlCondition: { maxSize: 10000 } },
                },
                {
                  test: /\\.svg$/,
                  use: [{ loader: '@svgr/webpack', options: { prettier: false } }, 'file-loader'],
                },
                {
                  test: /\\.(js|mjs|jsx|ts|tsx)$/,
                  include: path.resolve(__dirname, 'src'),
                  loader: 'babel-loader',
                  options: { presets: ['react-app'], cacheDirectory: true },
                },
                {
                  test: /\\.css$/,
                  use: [
                    isEnvProduction ? MiniCssExtractPlugin.loader : 'style-loader',
                    { loader: 'css-loader', options: { importLoaders: 1, modules: { mode: 'icss' } } },
                    'postcss-loader',
                  ],
                },
                {
                  test: /\\.module\\.scss$/,
                  use: [
                    'style-loader',
                    { loader: 'css-loader', options: { modules: true } },
                    { loader: 'sass-loader', options: { sourceMap: true } },
                  ],
                },
              ],
            },
          ],
        },
        plugins: [
          new HtmlWebpackPlugin({ inject: true, template: 'public/index.html', favicon: 'public/favicon.ico' }),
          new webpack.DefinePlugin({
            'process.env.NODE_ENV': JSON.stringify('production'),
            'process.env.PUBLIC_URL': JSON.stringify(''),
          }),
          new CaseSensitivePathsPlugin(),
          isEnvProduction && new MiniCssExtractPlugin({ filename: 'static/css/[name].[contenthash:8].css' }),
          new ForkTsCheckerWebpackPlugin({ async: false }),
        ].filter(Boolean),
        optimization: {
          minimize: isEnvProduction,
          splitChunks: { chunks: 'all', name: false },
          runtimeChunk: { name: (entrypoint) => 'runtime-' + entrypoint.name },
        },
        performance: false,
      };
    `,
  },
  {
    // vue-cli style webpack.base.js (webpack-chain output shape, vue-loader,
    // url-loader for assets, hand-written aliases).
    name: 'vue-cli-base',
    input: `
      const path = require('path');
      const { VueLoaderPlugin } = require('vue-loader');

      function resolve(dir) {
        return path.join(__dirname, '..', dir);
      }

      module.exports = {
        context: path.resolve(__dirname, '../'),
        entry: { app: './src/main.js' },
        output: {
          path: path.resolve(__dirname, '../dist'),
          filename: '[name].js',
          publicPath: '/',
        },
        resolve: {
          extensions: ['.js', '.vue', '.json'],
          alias: {
            'vue$': 'vue/dist/vue.esm.js',
            '@': path.resolve(__dirname, '../src'),
          },
        },
        module: {
          rules: [
            { test: /\\.vue$/, loader: 'vue-loader' },
            { test: /\\.js$/, loader: 'babel-loader', include: [path.resolve(__dirname, '../src')] },
            {
              test: /\\.(png|jpe?g|gif|svg)(\\?.*)?$/,
              loader: 'url-loader',
              options: { limit: 10000, name: 'img/[name].[hash:7].[ext]' },
            },
            {
              test: /\\.scss$/,
              use: [
                'vue-style-loader',
                'css-loader',
                { loader: 'sass-loader', options: { additionalData: '@import "@/styles/variables.scss";' } },
              ],
            },
          ],
        },
        plugins: [new VueLoaderPlugin()],
        devServer: {
          host: 'localhost',
          port: 8080,
          historyApiFallback: true,
          contentBase: './static',
          proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
        },
      };
    `,
  },
  {
    // Plain webpack 5 app using asset modules (no legacy file-loader).
    name: 'webpack5-asset-modules',
    input: `
      const path = require('path');
      const HtmlWebpackPlugin = require('html-webpack-plugin');

      module.exports = {
        mode: 'production',
        entry: './src/index.js',
        output: {
          path: path.resolve(__dirname, 'dist'),
          filename: '[name].[contenthash].js',
          assetModuleFilename: 'assets/[hash][ext][query]',
          clean: true,
        },
        module: {
          rules: [
            { test: /\\.(png|jpg|jpeg|gif)$/i, type: 'asset/resource' },
            { test: /\\.svg$/i, type: 'asset/inline' },
            { test: /\\.txt$/i, type: 'asset/source' },
            { test: /\\.woff2?$/i, type: 'asset', parser: { dataUrlCondition: { maxSize: 8192 } } },
          ],
        },
        plugins: [new HtmlWebpackPlugin({ title: 'Asset Modules Demo' })],
      };
    `,
  },
  {
    // Library build: single entry, UMD output, externalized peer deps.
    name: 'library-umd',
    input: `
      const path = require('path');

      module.exports = {
        mode: 'production',
        entry: path.resolve(__dirname, 'src/index.ts'),
        output: {
          path: path.resolve(__dirname, 'dist'),
          filename: 'my-widgets.js',
          library: { name: 'MyWidgets', type: 'umd' },
          globalObject: 'this',
        },
        resolve: { extensions: ['.ts', '.js'] },
        module: {
          rules: [{ test: /\\.ts$/, loader: 'ts-loader', exclude: /node_modules/ }],
        },
        externals: {
          react: { commonjs: 'react', commonjs2: 'react', amd: 'react', root: 'React' },
        },
        devtool: 'source-map',
      };
    `,
  },
  {
    // webpack-merge prod config layered over a base (the analyzer reads the
    // literal override; config.merge must flag the unseen base layer).
    name: 'webpack-merge-prod',
    input: `
      const { merge } = require('webpack-merge');
      const CompressionPlugin = require('compression-webpack-plugin');
      const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
      const common = require('./webpack.common.js');

      module.exports = merge(common, {
        mode: 'production',
        devtool: 'hidden-source-map',
        output: { publicPath: '/static/app/' },
        plugins: [
          new CompressionPlugin({ algorithm: 'gzip' }),
          process.env.ANALYZE ? new BundleAnalyzerPlugin() : null,
        ],
        optimization: {
          minimize: true,
          splitChunks: {
            cacheGroups: {
              vendor: { test: /[\\\\/]node_modules[\\\\/]/, name: 'vendors', chunks: 'all' },
            },
          },
        },
      });
    `,
  },
];

describe('real-project fixture suite', () => {
  for (const fx of REAL_FIXTURES) {
    describe(fx.name, () => {
      const result = analyzeWebpackConfig(fx.input);

      it('snapshots the rendered vite.config.ts output', () => {
        expect(result.output).toMatchSnapshot();
      });

      it('snapshots the migration report (tier:code → message)', () => {
        const report = result.warnings.map((w) => `${w.type}:${w.code} — ${w.message}`);
        expect(report).toMatchSnapshot();
      });

      it('snapshots the dependency checklist and confidence band', () => {
        expect({
          confidence: getConfidence(result.warnings),
          dependencies: result.dependencies.map((d) => `${d.required ? 'required' : 'optional'}:${d.name}`),
        }).toMatchSnapshot();
      });

      if (fx.name === 'cra-ejected' || fx.name === 'webpack5-asset-modules' || fx.name === 'vue-cli-base') {
        it('snapshots the generated index.html skeleton', () => {
          expect(result.indexHtml).toMatchSnapshot();
        });
      }
    });
  }
});
