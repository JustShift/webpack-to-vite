/** Confidence band derived from the warning tiers. Never a fake percentage. */
import type { Warning } from './types.js';

export type Confidence = 'High confidence' | 'Verify before merging' | 'Manual review required';

export function getConfidence(warnings: Warning[]): Confidence {
  const manual = warnings.filter((w) => w.type === 'manual');
  const verify = warnings.filter((w) => w.type === 'verify');

  const highRiskVerify = verify.some(
    (w) =>
      w.code.startsWith('entry.') ||
      w.code.startsWith('output.') ||
      w.code === 'module.cssModulesNaming' ||
      w.code === 'optimization.splitChunks' ||
      w.code === 'devServer.proxyRewrite'
  );

  if (manual.length > 0) return 'Manual review required';
  if (verify.length >= 3 || highRiskVerify) return 'Verify before merging';
  return 'High confidence';
}

/** Raw counts, e.g. "2 manual · 4 verify · 6 info". */
export function tierCounts(warnings: Warning[]): string {
  const manual = warnings.filter((w) => w.type === 'manual').length;
  const verify = warnings.filter((w) => w.type === 'verify').length;
  const info = warnings.filter((w) => w.type === 'info').length;
  return `${manual} manual · ${verify} verify · ${info} info`;
}
