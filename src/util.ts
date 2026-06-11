/** Small shared rendering/string helpers. */

/** Quote an object key only when it is not a plain identifier. */
export function quoteKey(key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return key;
  if (!key.includes("'") && !/[\\\n\r\t]/.test(key)) return `'${key}'`;
  return JSON.stringify(key);
}

/** Quote a string as a single-quoted JS string literal. */
export function quoteString(value: string): string {
  if (!value.includes("'") && !/[\\\n\r\t]/.test(value)) return `'${value}'`;
  return JSON.stringify(value);
}

/** Escape a string for safe insertion into a RegExp source. Also escapes `/`
 *  so the result can be rendered inside a regex literal. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Last path segment of a `/`-separated path (used to derive a Vite outDir). */
export function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}
