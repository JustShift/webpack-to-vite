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

describe('entry / output edge cases', () => {
  it('treats an array entry as a placeholder with a verify note', () => {
    const r = analyzeWebpackConfig("module.exports = { entry: ['./polyfills.js', './src/index.js'] };");
    expect(hasCode(r, 'entry.dynamic')).toBe(true);
    expect(r.warnings.find((w) => w.code === 'entry.dynamic')?.type).toBe('verify');
  });

  it('treats output.publicPath auto as verify without setting base', () => {
    const r = analyzeWebpackConfig("module.exports = { output: { publicPath: 'auto' } };");
    expect(hasCode(r, 'output.publicPath')).toBe(true);
    expect(r.output).not.toContain('base:');
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
