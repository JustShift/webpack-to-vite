import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Release-gate "lint rule": the analyzer must never reach for code execution.
// This guards the CSP-safe / no-execution promise at the source level (the worker
// runs under a strict CSP without 'unsafe-eval').
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const tsFiles = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

describe('no code execution in the analyzer source', () => {
  for (const file of tsFiles) {
    it(`${file} contains no eval / new Function / vm.runInContext`, () => {
      const code = readFileSync(join(srcDir, file), 'utf8');
      // Strip block + line comments so prose (e.g. JSDoc "no new Function") doesn't trip the check.
      const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(stripped).not.toMatch(/\beval\s*\(/);
      expect(stripped).not.toMatch(/\bnew\s+Function\b/);
      expect(stripped).not.toMatch(/\bvm\s*\.\s*runInContext\b/);
    });
  }
});
