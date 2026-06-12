import { describe, it, expect } from 'vitest';
import { analyzeWebpackConfig } from '../src/converter';
import { getConfidence } from '../src/confidence';

const codes = (r: ReturnType<typeof analyzeWebpackConfig>) => r.warnings.map((w) => w.code);
const hasCode = (r: ReturnType<typeof analyzeWebpackConfig>, code: string) => codes(r).includes(code as never);

describe('input shapes', () => {
  it('parses module.exports = {...}', () => {
    const r = analyzeWebpackConfig("module.exports = { mode: 'production' };");
    expect(r.output).toContain('export default defineConfig({');
  });

  it('parses export default {...}', () => {
    const r = analyzeWebpackConfig("export default { resolve: { extensions: ['.ts', '.js'] } };");
    expect(r.output).toContain("extensions: ['.ts', '.js']");
  });

  it('unwraps defineConfig({...})', () => {
    const r = analyzeWebpackConfig("export default defineConfig({ devtool: 'source-map' });");
    expect(r.output).toContain('sourcemap: true');
  });

  it('resolves const config = {...}; module.exports = config;', () => {
    const r = analyzeWebpackConfig("const config = { devtool: false }; module.exports = config;");
    expect(r.output).toContain('sourcemap: false');
  });

  it('unwraps TS satisfies', () => {
    const r = analyzeWebpackConfig("export default { mode: 'development' } satisfies Configuration;");
    expect(r.output).toContain('defineConfig');
  });

  it('reads function-form configs without executing them', () => {
    const r = analyzeWebpackConfig('module.exports = () => ({ mode: "development" });');
    expect(hasCode(r, 'config.functionForm')).toBe(true);
  });

  it('flags multi-config arrays', () => {
    const r = analyzeWebpackConfig('module.exports = [{ mode: "production" }, { mode: "development" }];');
    expect(r.warnings.some((w) => w.message.includes('Multiple configs'))).toBe(true);
  });

  it('returns config.parseError for invalid input', () => {
    const r = analyzeWebpackConfig('module.exports = {');
    expect(hasCode(r, 'config.parseError')).toBe(true);
    expect(r.warnings[0]!.type).toBe('manual');
  });

  it('returns config.notFound for non-config input', () => {
    const r = analyzeWebpackConfig('const x = 1;');
    expect(hasCode(r, 'config.notFound')).toBe(true);
  });
});

describe('safety: config is never executed', () => {
  it('does not run side-effecting function-form bodies', () => {
    const input = `module.exports = () => { throw new Error('should never run'); return { mode: 'production' }; };`;
    expect(() => analyzeWebpackConfig(input)).not.toThrow();
  });

  it('never emits eval / new Function in output', () => {
    const r = analyzeWebpackConfig("module.exports = { entry: './src/index.js' };");
    expect(r.output).not.toMatch(/\beval\s*\(/);
    expect(r.output).not.toMatch(/new\s+Function/);
  });
});

describe('resolve', () => {
  it('emits array-form alias with exact rule and __dirname warning', () => {
    const r = analyzeWebpackConfig(`
      const path = require('path');
      module.exports = { resolve: { alias: { '@': path.resolve(__dirname, 'src'), 'react$': './node_modules/react' } } };
    `);
    expect(r.output).toContain("{ find: '@', replacement: path.resolve(__dirname, 'src') }");
    expect(r.output).toContain('find: /^react$/');
    expect(hasCode(r, 'resolve.dirnameEsm')).toBe(true);
    expect(hasCode(r, 'resolve.aliasExact')).toBe(true);
    expect(r.output).toContain("import path from 'node:path';");
  });

  it('does not flatten array-valued aliases', () => {
    const r = analyzeWebpackConfig("module.exports = { resolve: { alias: { '@': ['./a', './b'] } } };");
    expect(hasCode(r, 'resolve.aliasArrayValue')).toBe(true);
  });
});

describe('module / loaders', () => {
  it('treats babel/ts loaders as native (info) and notes no type-checking', () => {
    const r = analyzeWebpackConfig("module.exports = { module: { rules: [{ test: /x/, loader: 'babel-loader' }] } };");
    expect(hasCode(r, 'module.nativeLoader')).toBe(true);
    expect(r.warnings.some((w) => w.message.includes('type-check'))).toBe(true);
  });

  it('flags an unknown loader as manual', () => {
    const r = analyzeWebpackConfig("module.exports = { module: { rules: [{ test: /x/, loader: 'my-loader' }] } };");
    expect(hasCode(r, 'module.customLoader')).toBe(true);
    expect(r.flags.hasCustomLoaders).toBe(true);
  });

  it('maps sass-loader to a preprocessor dependency', () => {
    const r = analyzeWebpackConfig("module.exports = { module: { rules: [{ test: /s/, use: ['sass-loader'] }] } };");
    expect(r.flags.needsSass).toBe(true);
    expect(r.dependencies.some((d) => d.name === 'sass' && d.required)).toBe(true);
  });

  it('detects css-loader modules without .module suffix', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { module: { rules: [{ test: /c/, use: [{ loader: 'css-loader', options: { modules: true } }] }] } };"
    );
    expect(hasCode(r, 'module.cssModulesNaming')).toBe(true);
    expect(r.flags.usesCssModulesWithoutModuleSuffix).toBe(true);
  });
});

describe('DefinePlugin', () => {
  it('maps constants and shims process.env keys', () => {
    const r = analyzeWebpackConfig(`
      module.exports = { plugins: [ new webpack.DefinePlugin({ 'process.env.API': JSON.stringify('x'), VERSION: JSON.stringify('1') }) ] };
    `);
    expect(r.output).toContain("VERSION: JSON.stringify('1')");
    expect(r.output).toContain('compatibility shim');
    expect(hasCode(r, 'plugin.defineEnv')).toBe(true);
    expect(r.flags.hasProcessEnvSource).toBe(true);
  });
});

describe('devServer proxy', () => {
  it('builds a rewrite function from simple pathRewrite', () => {
    const r = analyzeWebpackConfig(`
      module.exports = { devServer: { proxy: { '/api': { target: 'http://x', pathRewrite: { '^/api': '' } } } } };
    `);
    expect(r.output).toContain('rewrite: (p) => p.replace(');
    expect(hasCode(r, 'devServer.proxyRewrite')).toBe(true);
    expect(r.flags.hasProxyRewrite).toBe(true);
  });

  it('adds changeOrigin when proxy value is a bare string', () => {
    const r = analyzeWebpackConfig("module.exports = { devServer: { proxy: { '/api': 'http://localhost:8080' } } };");
    expect(r.output).toContain('changeOrigin: true');
  });
});

describe('externals / target / devtool', () => {
  it('always treats externals as manual', () => {
    const r = analyzeWebpackConfig("module.exports = { externals: { react: 'React' } };");
    expect(hasCode(r, 'externals.detected')).toBe(true);
    expect(r.flags.hasExternals).toBe(true);
  });

  it('drops target web (info) and flags node target (manual)', () => {
    const web = analyzeWebpackConfig("module.exports = { target: 'web' };");
    expect(hasCode(web, 'target.web')).toBe(true);
    const node = analyzeWebpackConfig("module.exports = { target: 'node' };");
    expect(hasCode(node, 'target.ssr')).toBe(true);
    expect(node.warnings.find((w) => w.code === 'target.ssr')?.type).toBe('manual');
  });

  it('maps devtool variants', () => {
    expect(analyzeWebpackConfig("module.exports = { devtool: 'inline-source-map' };").output).toContain("sourcemap: 'inline'");
    expect(analyzeWebpackConfig("module.exports = { devtool: 'hidden-source-map' };").output).toContain("sourcemap: 'hidden'");
  });
});

describe('Vite 8 default vs Vite 7 fallback', () => {
  it('defaults to rolldownOptions (Vite 8)', () => {
    const r = analyzeWebpackConfig("module.exports = { entry: './src/index.js' };");
    expect(r.output).toContain('rolldownOptions: {');
    expect(r.output).not.toContain('rollupOptions: {');
    expect(r.flags.targetViteMajor).toBe(8);
  });

  it('emits rollupOptions when targetViteMajor is 7', () => {
    const r = analyzeWebpackConfig("module.exports = { entry: './src/index.js' };", { targetViteMajor: 7 });
    expect(r.output).toContain('rollupOptions: {');
    expect(r.output).not.toContain('rolldownOptions: {');
  });

  it('enables built-in tsconfigPaths for Vite 8 but the plugin for Vite 7', () => {
    const input = `
      const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
      module.exports = { resolve: { plugins: [new TsconfigPathsPlugin()] } };
    `;
    const v8 = analyzeWebpackConfig(input);
    expect(v8.output).toContain('tsconfigPaths: true');
    expect(v8.dependencies.some((d) => d.name === 'vite-tsconfig-paths')).toBe(false);

    const v7 = analyzeWebpackConfig(input, { targetViteMajor: 7 });
    expect(v7.output).toContain('tsconfigPaths()');
    expect(v7.output).toContain("import tsconfigPaths from 'vite-tsconfig-paths';");
    expect(v7.dependencies.some((d) => d.name === 'vite-tsconfig-paths' && d.required)).toBe(true);
  });
});

describe('confidence band', () => {
  it('is high confidence for an info-only config', () => {
    const r = analyzeWebpackConfig("module.exports = { mode: 'production', target: 'web' };");
    expect(getConfidence(r.warnings)).toBe('High confidence');
  });

  it('requires manual review when any manual warning exists', () => {
    const r = analyzeWebpackConfig("module.exports = { externals: { react: 'React' } };");
    expect(getConfidence(r.warnings)).toBe('Manual review required');
  });
});

describe('dependencies', () => {
  it('always lists vite as required', () => {
    const r = analyzeWebpackConfig("module.exports = { mode: 'production' };");
    expect(r.dependencies[0]).toMatchObject({ name: 'vite', required: true });
  });
});

describe('DefinePlugin NODE_ENV', () => {
  it('drops process.env.NODE_ENV instead of shimming it', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { plugins: [ new webpack.DefinePlugin({ 'process.env.NODE_ENV': JSON.stringify('production') }) ] };"
    );
    expect(r.output).not.toContain('process.env.NODE_ENV');
    expect(r.output).not.toContain('define: {');
    expect(r.warnings.find((w) => w.message.includes('NODE_ENV'))?.type).toBe('info');
  });
});

describe('framework plugin detection', () => {
  it('wires in @vitejs/plugin-react on a React signal', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { module: { rules: [{ test: /x/, use: [{ loader: 'babel-loader', options: { presets: ['@babel/preset-react'] } }] }] } };"
    );
    expect(r.output).toContain("import react from '@vitejs/plugin-react';");
    expect(r.output).toContain('react()');
    expect(r.dependencies.some((d) => d.name === '@vitejs/plugin-react' && d.required)).toBe(true);
    expect(hasCode(r, 'framework.plugin')).toBe(true);
  });

  it('wires in @vitejs/plugin-vue on a Vue signal and prefers it over React', () => {
    const r = analyzeWebpackConfig("module.exports = { module: { rules: [{ test: /\\.vue$/, use: ['vue-loader'] }] } };");
    expect(r.output).toContain("import vue from '@vitejs/plugin-vue';");
    expect(r.output).toContain('vue()');
    expect(r.output).not.toContain('@vitejs/plugin-react');
  });

  it('adds no framework plugin for a plain config', () => {
    const r = analyzeWebpackConfig("module.exports = { mode: 'production' };");
    expect(r.dependencies.every((d) => !d.name.startsWith('@vitejs/plugin-'))).toBe(true);
  });
});

describe('webpack-merge', () => {
  it('warns when webpack-merge is used', () => {
    const r = analyzeWebpackConfig(
      "const { merge } = require('webpack-merge'); module.exports = merge(base, { mode: 'production' });"
    );
    expect(hasCode(r, 'config.merge')).toBe(true);
  });
});

describe('plugin coverage', () => {
  it('treats HMR/Clean plugins as benign (info)', () => {
    const r = analyzeWebpackConfig(
      'module.exports = { plugins: [ new webpack.HotModuleReplacementPlugin(), new CleanWebpackPlugin() ] };'
    );
    const benign = r.warnings.filter((w) => w.code === 'plugin.benign');
    expect(benign.length).toBe(2);
    expect(benign.every((w) => w.type === 'info')).toBe(true);
  });

  it('suggests checker / compression / visualizer plugins', () => {
    const r = analyzeWebpackConfig(`
      module.exports = { plugins: [ new ForkTsCheckerWebpackPlugin(), new CompressionPlugin(), new BundleAnalyzerPlugin() ] };
    `);
    expect(r.flags.needsChecker).toBe(true);
    expect(r.flags.needsCompression).toBe(true);
    expect(r.flags.needsVisualizer).toBe(true);
    expect(r.dependencies.some((d) => d.name === 'vite-plugin-checker')).toBe(true);
    expect(r.dependencies.some((d) => d.name === 'rollup-plugin-visualizer')).toBe(true);
  });

  it('flags an unknown plugin as manual', () => {
    const r = analyzeWebpackConfig('module.exports = { plugins: [ new TotallyCustomPlugin() ] };');
    expect(hasCode(r, 'plugin.unknown')).toBe(true);
    expect(r.flags.hasComplexPlugins).toBe(true);
  });
});

describe('dynamic / wrapped sections', () => {
  it('sees through plugins: [...].filter(Boolean)', () => {
    const r = analyzeWebpackConfig(`
      module.exports = {
        plugins: [
          new HtmlWebpackPlugin({ template: './public/index.html' }),
          process.env.ANALYZE && new BundleAnalyzerPlugin(),
        ].filter(Boolean),
      };
    `);
    expect(hasCode(r, 'plugin.html')).toBe(true);
    expect(hasCode(r, 'plugin.visualizer')).toBe(true);
    expect(hasCode(r, 'config.dynamic')).toBe(false);
  });

  it('sees through plugins: [...].concat(cond ? [...] : [])', () => {
    const r = analyzeWebpackConfig(`
      module.exports = {
        plugins: [new MiniCssExtractPlugin()].concat(isProd ? [new CompressionPlugin()] : []),
      };
    `);
    expect(hasCode(r, 'plugin.miniCss')).toBe(true);
    expect(hasCode(r, 'plugin.compression')).toBe(true);
    expect(hasCode(r, 'config.dynamic')).toBe(false);
  });

  it('classifies both branches of a ternary plugin element', () => {
    const r = analyzeWebpackConfig(`
      module.exports = {
        plugins: [isProd ? new CompressionPlugin() : new ForkTsCheckerWebpackPlugin()],
      };
    `);
    expect(hasCode(r, 'plugin.compression')).toBe(true);
    expect(hasCode(r, 'plugin.checker')).toBe(true);
  });

  it('warns on a non-literal .concat() argument but keeps the literal part', () => {
    const r = analyzeWebpackConfig(`
      module.exports = { plugins: [new HtmlWebpackPlugin()].concat(extraPlugins) };
    `);
    expect(hasCode(r, 'plugin.html')).toBe(true);
    const dynamic = r.warnings.find((w) => w.code === 'config.dynamic');
    expect(dynamic?.type).toBe('manual');
  });

  it('warns instead of silently dropping a dynamic plugins value', () => {
    const r = analyzeWebpackConfig('module.exports = { plugins: getPlugins() };');
    const dynamic = r.warnings.find((w) => w.code === 'config.dynamic');
    expect(dynamic?.type).toBe('manual');
    expect(dynamic?.message).toContain("'plugins'");
  });

  it('warns instead of silently dropping dynamic object sections', () => {
    for (const key of ['output', 'resolve', 'module', 'devServer', 'optimization']) {
      const r = analyzeWebpackConfig(`module.exports = { ${key}: makeSection() };`);
      const dynamic = r.warnings.find((w) => w.code === 'config.dynamic');
      expect(dynamic?.type, `section '${key}'`).toBe('manual');
      expect(dynamic?.message).toContain(`'${key}'`);
    }
  });
});

describe('entry / output edge cases', () => {
  it('uses the LAST array entry (webpack exports the last element)', () => {
    const r = analyzeWebpackConfig("module.exports = { entry: ['./polyfills.js', './src/index.js'] };");
    expect(hasCode(r, 'entry.dynamic')).toBe(true);
    expect(r.warnings.find((w) => w.code === 'entry.dynamic')?.type).toBe('verify');
    expect(r.output).toContain("input: './src/index.js'");
    expect(r.output).not.toContain('polyfills');
  });

  it('treats output.publicPath auto as verify without setting base', () => {
    const r = analyzeWebpackConfig("module.exports = { output: { publicPath: 'auto' } };");
    expect(hasCode(r, 'output.publicPath')).toBe(true);
    expect(r.output).not.toContain('base:');
  });

  it('keeps nested output.path directories intact', () => {
    const r = analyzeWebpackConfig(`
      const path = require('path');
      module.exports = { output: { path: path.resolve(__dirname, 'build/static') } };
    `);
    expect(r.output).toContain("outDir: 'build/static'");
  });

  it('falls back to the last segment for absolute output.path with a verify note', () => {
    const r = analyzeWebpackConfig("module.exports = { output: { path: '/var/www/dist' } };");
    expect(r.output).toContain("outDir: 'dist'");
    expect(r.warnings.find((w) => w.code === 'output.outDir')?.type).toBe('verify');
  });

  it('emits build.lib for output.library object form', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { entry: './src/index.ts', output: { library: { name: 'MyLib', type: 'umd' } } };"
    );
    const w = r.warnings.find((x) => x.code === 'output.library');
    expect(w?.type).toBe('verify');
    expect(r.output).toContain('lib: {');
    expect(r.output).toContain("entry: './src/index.ts'");
    expect(r.output).toContain("name: 'MyLib'");
    expect(r.output).toContain("formats: ['umd']");
    // The entry moved into build.lib; no separate bundler input.
    expect(r.output).not.toContain('input:');
  });

  it('maps libraryTarget string forms to build.lib formats', () => {
    const cjs = analyzeWebpackConfig("module.exports = { output: { libraryTarget: 'commonjs2' } };");
    expect(cjs.output).toContain("formats: ['cjs']");
    const esm = analyzeWebpackConfig("module.exports = { output: { library: { type: 'module' } } };");
    expect(esm.output).toContain("formats: ['es']");
    expect(esm.output).toContain('// TODO: no static webpack entry was detected');
  });

  it('falls back to manual for an unknown library type', () => {
    const r = analyzeWebpackConfig("module.exports = { output: { libraryTarget: 'amd' } };");
    const w = r.warnings.find((x) => x.code === 'output.library' && x.type === 'manual');
    expect(w?.message).toContain("'amd'");
  });

  it('warns on unrecognized output keys instead of dropping them silently', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { output: { assetModuleFilename: 'assets/[hash][ext]' } };"
    );
    const w = r.warnings.find((x) => x.code === 'output.unmapped');
    expect(w?.type).toBe('manual');
    expect(w?.message).toContain('assetModuleFilename');
  });

  it('escapes slashes in exact-match alias regexes', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { resolve: { alias: { '@app/core$': './src/core' } } };"
    );
    expect(r.output).toContain('find: /^@app\\/core$/');
  });
});

describe('devServer https', () => {
  it('does not emit boolean https (invalid in Vite); suggests basic-ssl', () => {
    const r = analyzeWebpackConfig('module.exports = { devServer: { https: true } };');
    expect(r.output).not.toContain('https: true');
    expect(r.warnings.find((w) => w.code === 'devServer.https')?.type).toBe('verify');
    expect(r.dependencies.some((d) => d.name === '@vitejs/plugin-basic-ssl')).toBe(true);
  });

  it('copies https cert options through', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { devServer: { https: { key: './k.pem', cert: './c.pem' } } };"
    );
    expect(r.output).toContain('https: {');
    expect(r.output).toContain("key: './k.pem'");
  });

  it("drops server: 'http' instead of turning it into HTTPS", () => {
    const r = analyzeWebpackConfig("module.exports = { devServer: { server: 'http' } };");
    expect(r.output).not.toContain('https');
    expect(hasCode(r, 'devServer.https')).toBe(false);
  });

  it("maps server: 'https' to the cert guidance", () => {
    const r = analyzeWebpackConfig("module.exports = { devServer: { server: 'https' } };");
    expect(r.output).not.toContain('https: true');
    expect(hasCode(r, 'devServer.https')).toBe(true);
  });

  it('copies server: { type, options } cert options through', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { devServer: { server: { type: 'https', options: { key: './k.pem' } } } };"
    );
    expect(r.output).toContain("key: './k.pem'");
  });
});

describe('webpack 5 asset modules', () => {
  it('reports asset/resource and asset as native (info)', () => {
    const r = analyzeWebpackConfig(`
      module.exports = { module: { rules: [
        { test: /\\.png$/, type: 'asset/resource' },
        { test: /\\.gif$/, type: 'asset' },
      ] } };
    `);
    const ws = r.warnings.filter((w) => w.code === 'module.assetLoader');
    expect(ws.length).toBe(2);
    expect(ws.every((w) => w.type === 'info')).toBe(true);
  });

  it('flags asset/inline and asset/source import-shape changes (verify)', () => {
    const r = analyzeWebpackConfig(`
      module.exports = { module: { rules: [
        { test: /\\.svg$/, type: 'asset/inline' },
        { test: /\\.txt$/, type: 'asset/source' },
      ] } };
    `);
    const ws = r.warnings.filter((w) => w.code === 'module.assetLoader');
    expect(ws.length).toBe(2);
    expect(ws.every((w) => w.type === 'verify')).toBe(true);
    expect(ws.some((w) => w.message.includes("'?raw'"))).toBe(true);
  });
});

describe('nested unmapped keys (silent-drop guard)', () => {
  it('warns on unrecognized resolve keys', () => {
    const r = analyzeWebpackConfig("module.exports = { resolve: { mainFields: ['browser', 'module'] } };");
    const w = r.warnings.find((x) => x.code === 'resolve.unmapped');
    expect(w?.type).toBe('manual');
    expect(w?.message).toContain('mainFields');
  });

  it('points resolve.symlinks at preserveSymlinks (verify)', () => {
    const r = analyzeWebpackConfig('module.exports = { resolve: { symlinks: false } };');
    const w = r.warnings.find((x) => x.code === 'resolve.unmapped');
    expect(w?.type).toBe('verify');
    expect(w?.message).toContain('preserveSymlinks');
  });

  it('does not flag resolve.plugins when it is the tsconfig-paths plugin', () => {
    const r = analyzeWebpackConfig(`
      const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
      module.exports = { resolve: { plugins: [new TsconfigPathsPlugin()] } };
    `);
    expect(r.warnings.some((w) => w.code === 'resolve.unmapped')).toBe(false);
  });

  it('warns on unrecognized module keys like noParse', () => {
    const r = analyzeWebpackConfig('module.exports = { module: { noParse: /jquery/, rules: [] } };');
    const w = r.warnings.find((x) => x.code === 'module.unmapped');
    expect(w?.type).toBe('manual');
    expect(w?.message).toContain('noParse');
  });

  it('warns when module.rules itself is dynamic', () => {
    const r = analyzeWebpackConfig('module.exports = { module: { rules: getRules() } };');
    const w = r.warnings.find((x) => x.code === 'module.unmapped');
    expect(w?.type).toBe('manual');
    expect(w?.message).toContain('module.rules');
  });
});

describe('css.preprocessorOptions emission', () => {
  it('moves sass-loader additionalData and sassOptions into css.preprocessorOptions.scss', () => {
    const r = analyzeWebpackConfig(`
      module.exports = { module: { rules: [{
        test: /\\.scss$/,
        use: ['style-loader', 'css-loader', {
          loader: 'sass-loader',
          options: {
            additionalData: '@use "sass:math";',
            implementation: require('sass'),
            sassOptions: { includePaths: ['./src/styles'] },
          },
        }],
      }] } };
    `);
    expect(r.output).toContain('css: {');
    expect(r.output).toContain('preprocessorOptions: {');
    expect(r.output).toContain('scss: {');
    expect(r.output).toContain(`additionalData: '@use "sass:math";'`);
    expect(r.output).toContain("includePaths: ['./src/styles']");
    // implementation is handled by Vite itself.
    expect(r.output).not.toContain('implementation');
    const w = r.warnings.find((x) => x.code === 'module.preprocessor');
    expect(w?.message).toContain('css.preprocessorOptions.scss');
  });

  it('emits no css block for option-less preprocessor loaders', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { module: { rules: [{ test: /\\.less$/, use: ['less-loader'] }] } };"
    );
    expect(r.output).not.toContain('css: {');
  });
});

describe('entry static-eval', () => {
  it('resolves path.resolve(__dirname, ...) entries instead of falling to manual', () => {
    const r = analyzeWebpackConfig(`
      const path = require('path');
      module.exports = { entry: path.resolve(__dirname, 'src/index.js') };
    `);
    expect(hasCode(r, 'entry.mapped')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'entry.dynamic' && w.type === 'manual')).toBe(false);
    expect(r.output).toContain("input: './src/index.js'");
  });

  it('resolves path.resolve values inside object-form entries', () => {
    const r = analyzeWebpackConfig(`
      const path = require('path');
      module.exports = { entry: { main: path.resolve(__dirname, 'src/main.ts'), admin: './src/admin.ts' } };
    `);
    expect(r.output).toContain("main: './src/main.ts'");
    expect(r.output).toContain("admin: './src/admin.ts'");
  });
});

describe('devServer.static → publicDir', () => {
  it('maps a static string to publicDir', () => {
    const r = analyzeWebpackConfig("module.exports = { devServer: { static: './public' } };");
    expect(r.output).toContain("publicDir: './public'");
  });

  it('maps a { directory } object (incl. path.resolve) to publicDir', () => {
    const r = analyzeWebpackConfig(`
      const path = require('path');
      module.exports = { devServer: { static: { directory: path.resolve(__dirname, 'public') } } };
    `);
    expect(r.output).toContain("publicDir: 'public'");
  });

  it('maps webpack 4 contentBase to publicDir', () => {
    const r = analyzeWebpackConfig("module.exports = { devServer: { contentBase: './assets' } };");
    expect(r.output).toContain("publicDir: './assets'");
  });

  it('falls back to the loose-mapping note for boolean/dynamic values', () => {
    const r = analyzeWebpackConfig('module.exports = { devServer: { static: true } };');
    expect(r.output).not.toContain('publicDir:');
    expect(r.warnings.some((w) => w.code === 'devServer.basic' && w.message.includes('publicDir'))).toBe(true);
  });
});

describe('index.html skeleton', () => {
  it('generates an index.html with the detected entry and title', () => {
    const r = analyzeWebpackConfig(`
      const HtmlWebpackPlugin = require('html-webpack-plugin');
      module.exports = {
        entry: './src/index.tsx',
        plugins: [new HtmlWebpackPlugin({ template: './public/index.html', title: 'My App', favicon: './public/favicon.ico' })],
      };
    `);
    expect(r.indexHtml).toBeDefined();
    expect(r.indexHtml).toContain('<script type="module" src="/src/index.tsx"></script>');
    expect(r.indexHtml).toContain('<title>My App</title>');
    expect(r.indexHtml).toContain('<link rel="icon" href="/public/favicon.ico" />');
    expect(r.indexHtml).toContain('template: ./public/index.html');
  });

  it('emits a TODO placeholder when no static entry was detected', () => {
    const r = analyzeWebpackConfig(`
      module.exports = { entry: getEntry(), plugins: [new HtmlWebpackPlugin()] };
    `);
    expect(r.indexHtml).toContain('TODO: no static webpack entry was detected');
    expect(r.indexHtml).toContain('src="/src/main.js"');
  });

  it('does not generate index.html without HtmlWebpackPlugin', () => {
    const r = analyzeWebpackConfig("module.exports = { entry: './src/index.js' };");
    expect(r.indexHtml).toBeUndefined();
  });
});

describe('resolve.fallback', () => {
  it('flags Node polyfill fallbacks and suggests vite-plugin-node-polyfills', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { resolve: { fallback: { crypto: 'crypto-browserify', buffer: 'buffer' } } };"
    );
    expect(r.warnings.find((w) => w.code === 'resolve.fallback')?.type).toBe('manual');
    expect(r.flags.needsNodePolyfills).toBe(true);
    expect(r.dependencies.some((d) => d.name === 'vite-plugin-node-polyfills')).toBe(true);
  });
});

describe('framework loader/plugin pairs', () => {
  it('classifies vue-loader and VueLoaderPlugin as replaced, not manual', () => {
    const r = analyzeWebpackConfig(`
      const { VueLoaderPlugin } = require('vue-loader');
      module.exports = {
        module: { rules: [{ test: /\\.vue$/, loader: 'vue-loader' }] },
        plugins: [new VueLoaderPlugin()],
      };
    `);
    expect(hasCode(r, 'module.customLoader')).toBe(false);
    expect(hasCode(r, 'plugin.unknown')).toBe(false);
    expect(r.warnings.some((w) => w.type === 'manual')).toBe(false);
    expect(r.output).toContain('vue()');
  });
});

describe('multi-config code', () => {
  it('emits config.multiConfig for exported config arrays', () => {
    const r = analyzeWebpackConfig('module.exports = [{ mode: "production" }, { mode: "development" }];');
    expect(hasCode(r, 'config.multiConfig')).toBe(true);
    expect(hasCode(r, 'config.functionForm')).toBe(false);
  });
});

describe('target / loaders edge cases', () => {
  it('flags an electron target as manual', () => {
    const r = analyzeWebpackConfig("module.exports = { target: 'electron-renderer' };");
    expect(r.warnings.find((w) => w.code === 'target.ssr')?.type).toBe('manual');
  });

  it('classifies less and stylus loaders with their deps', () => {
    const less = analyzeWebpackConfig("module.exports = { module: { rules: [{ test: /l/, use: ['less-loader'] }] } };");
    expect(less.flags.needsLess).toBe(true);
    const styl = analyzeWebpackConfig("module.exports = { module: { rules: [{ test: /s/, use: ['stylus-loader'] }] } };");
    expect(styl.flags.needsStylus).toBe(true);
  });

  it('walks nested oneOf rules', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { module: { rules: [{ oneOf: [{ test: /w/, use: ['worker-loader'] }] }] } };"
    );
    expect(hasCode(r, 'module.workerLoader')).toBe(true);
    expect(r.flags.hasWebWorkers).toBe(true);
  });
});

describe('source scan (opt-in)', () => {
  const scan = (content: string) =>
    analyzeWebpackConfig('module.exports = {};', { sourceFiles: [{ path: 'src/x.js', content }] });

  it('detects web workers, module.hot, and process.env in source', () => {
    const worker = scan("const w = new Worker('./worker.js');");
    expect(worker.flags.hasWebWorkers).toBe(true);

    const hot = scan('if (module.hot) module.hot.accept();');
    expect(hot.warnings.some((w) => w.code === 'source.moduleHot')).toBe(true);

    const env = scan('const k = process.env.SECRET_KEY;');
    expect(env.flags.hasProcessEnvSource).toBe(true);
  });

  it('detects dynamic import with a variable', () => {
    const r = scan('const load = (n) => import(`./pages/${n}.js`);');
    expect(r.warnings.some((w) => w.code === 'source.requireContext' && w.type === 'manual')).toBe(true);
  });

  it('attaches the source path to source warnings', () => {
    const r = scan("const ctx = require.context('./m', true, /\\.js$/);");
    expect(r.warnings.find((w) => w.code === 'source.requireContext')?.path).toBe('src/x.js');
  });
});
