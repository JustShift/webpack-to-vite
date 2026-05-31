/** Derive the required/suggested dependency checklist from the conversion flags. */
import type { ConversionFlags, DependencySuggestion } from './types.js';

export function buildDependencies(flags: ConversionFlags): DependencySuggestion[] {
  const deps: DependencySuggestion[] = [
    { name: 'vite', reason: 'The build tool itself.', required: true },
  ];

  if (flags.needsSvgr) {
    deps.push({
      name: 'vite-plugin-svgr',
      reason: 'Import SVGs as React components (replaces @svgr/webpack).',
      required: true,
      caution: "Source imports must use the '?react' suffix, e.g. import Logo from './logo.svg?react'.",
    });
  }
  if (flags.needsSass) {
    deps.push({ name: 'sass', reason: 'Vite needs the Sass compiler for .scss/.sass files.', required: true });
  }
  if (flags.needsLess) {
    deps.push({ name: 'less', reason: 'Vite needs the Less compiler for .less files.', required: true });
  }
  if (flags.needsStylus) {
    deps.push({ name: 'stylus', reason: 'Vite needs the Stylus compiler for .styl files.', required: true });
  }
  if (flags.needsTsconfigPaths && flags.targetViteMajor === 7) {
    deps.push({
      name: 'vite-tsconfig-paths',
      reason: 'Resolve TypeScript path aliases (Vite 7 has no built-in tsconfig paths).',
      required: true,
      caution: 'Vite 8 resolves tsconfig paths natively (resolve.tsconfigPaths: true) — no plugin needed there.',
    });
  }
  if (flags.needsStaticCopy) {
    deps.push({
      name: 'vite-plugin-static-copy',
      reason: 'Copy files with custom source/target patterns (replaces CopyWebpackPlugin).',
      required: false,
      caution: 'Prefer Vite publicDir for files served as-is; only use this for non-trivial copy patterns.',
    });
  }
  if (flags.needsChecker) {
    deps.push({
      name: 'vite-plugin-checker',
      reason: 'In-dev TypeScript / ESLint overlays (Vite does not type-check or lint during build).',
      required: false,
      caution: 'Often better run as a separate `tsc --noEmit` / eslint step in CI.',
    });
  }
  if (flags.needsVisualizer) {
    deps.push({
      name: 'rollup-plugin-visualizer',
      reason: 'Inspect bundle composition (replaces BundleAnalyzerPlugin). Works with Vite/Rolldown.',
      required: false,
    });
  }
  if (flags.needsCompression) {
    deps.push({
      name: 'vite-plugin-compression2',
      reason: 'Emit precompressed .gz/.br assets (replaces CompressionPlugin).',
      required: false,
      caution: 'Only needed if you serve precompressed assets yourself; otherwise let your CDN/host compress.',
    });
  }
  if (flags.needsNodePolyfills) {
    deps.push({
      name: 'vite-plugin-node-polyfills',
      reason: 'Polyfill Node core modules/globals for the browser (from ProvidePlugin or source usage).',
      required: false,
      caution: 'Use sparingly — prefer removing the dependency on Node globals over shimming them.',
    });
  }

  return deps;
}
