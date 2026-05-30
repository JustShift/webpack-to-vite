import { describe, it, expect } from 'vitest';
import { analyzeWebpackConfig } from '../src/converter';

const messages = (warnings: { message: string }[]) => warnings.map((w) => w.message);

describe('analyzeWebpackConfig — input shapes', () => {
  it('parses module.exports = {...}', () => {
    const r = analyzeWebpackConfig("module.exports = { mode: 'production' };");
    expect(r.output).toContain('defineConfig');
  });

  it('parses export default {...}', () => {
    const r = analyzeWebpackConfig("export default { resolve: { extensions: ['.ts', '.js'] } };");
    expect(r.output).toContain("extensions: [\".ts\", \".js\"]");
  });

  it('unwraps function-form configs', () => {
    const r = analyzeWebpackConfig("module.exports = () => ({ mode: 'development' });");
    expect(r.output).toContain('defineConfig');
  });

  it('returns a manual warning for non-config input', () => {
    const r = analyzeWebpackConfig('const x = 1;');
    expect(r.warnings.some((w) => w.type === 'manual')).toBe(true);
  });
});

describe('analyzeWebpackConfig — mapping', () => {
  it('maps resolve.alias to vite resolve.alias', () => {
    const r = analyzeWebpackConfig("module.exports = { resolve: { alias: { '@': './src' } } };");
    expect(r.output).toContain('alias');
    expect(r.output).toContain('@');
    expect(r.output).toContain('./src');
  });

  it('classifies a babel-loader as native', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { module: { rules: [{ test: /\\.js$/, loader: 'babel-loader' }] } };"
    );
    expect(messages(r.warnings).some((m) => m.includes('babel-loader') && m.includes('natively'))).toBe(true);
  });

  it('flags an svg loader as needing vite-plugin-svgr', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { module: { rules: [{ test: /\\.svg$/, use: ['@svgr/webpack'] }] } };"
    );
    expect(r.flags.needsSvgr).toBe(true);
    expect(r.output).toContain('vite-plugin-svgr');
  });

  it('flags sass-loader as needing sass', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { module: { rules: [{ test: /\\.scss$/, use: ['style-loader', 'css-loader', 'sass-loader'] }] } };"
    );
    expect(r.flags.needsSass).toBe(true);
  });

  it('classifies HtmlWebpackPlugin and DefinePlugin', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { plugins: [new HtmlWebpackPlugin(), new webpack.DefinePlugin({})] };"
    );
    expect(messages(r.warnings).some((m) => m.includes('HtmlWebpackPlugin'))).toBe(true);
    expect(messages(r.warnings).some((m) => m.includes('DefinePlugin'))).toBe(true);
    expect(r.output).toContain('define:');
  });

  it('maps devServer.port to server', () => {
    const r = analyzeWebpackConfig("module.exports = { devServer: { port: 8080 } };");
    expect(r.output).toContain('server:');
    expect(r.output).toContain('8080');
  });

  it('flags an unknown custom loader as manual', () => {
    const r = analyzeWebpackConfig(
      "module.exports = { module: { rules: [{ test: /\\.foo$/, loader: 'my-custom-loader' }] } };"
    );
    expect(r.flags.hasCustomLoaders).toBe(true);
  });
});
