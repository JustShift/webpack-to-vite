export { analyzeWebpackConfig } from './converter.js';
export { getConfidence, tierCounts, type Confidence } from './confidence.js';
export { buildDependencies } from './dependencies.js';
export type {
  AnalyzeOptions,
  ConversionResult,
  ConversionFlags,
  DependencySuggestion,
  Warning,
  WarningCode,
  WarningType,
} from './types.js';
