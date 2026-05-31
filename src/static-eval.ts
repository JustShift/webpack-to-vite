/**
 * Safe static evaluator + source helpers.
 *
 * The evaluator never executes user code. It walks the Babel AST and resolves
 * ONLY a small allowlist of provably-static shapes to concrete JS values:
 *
 *   string | number | boolean | null
 *   array literals · object literals (string/number/identifier keys)
 *   template literals without expressions
 *   JSON.stringify(<literal>)
 *   path.resolve(__dirname, 'x') · path.join(__dirname, 'x')   (-> joined string)
 *   simple RegExp literals
 *
 * Anything else — runtime identifiers, computed keys, spreads, conditionals,
 * non-allowlisted calls, unprovable member expressions — yields { ok: false }.
 * Callers decide what to do with an unresolved value (usually: warn + keep the
 * original source via getSource).
 */
import _generator from '@babel/generator';
import * as t from '@babel/types';

// Babel ships CJS that interops oddly with NodeNext + strict TS. The runtime
// check picks the callable regardless of how the bundler resolves default.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const generate: any =
  typeof _generator === 'function'
    ? _generator
    : (_generator as unknown as { default: unknown }).default;

export type EvalOk = { ok: true; value: unknown };
export type EvalErr = { ok: false; reason: string };
export type EvalResult = EvalOk | EvalErr;

const ok = (value: unknown): EvalOk => ({ ok: true, value });
const err = (reason: string): EvalErr => ({ ok: false, reason });

/** Generate readable source for a node (used when we keep an expression as-is). */
export function getSource(node: t.Node): string {
  return generate(node, { jsescOption: { quotes: 'single' } }).code;
}

/** Generate compact (single-line) source for a node. */
export function getCompactSource(node: t.Node): string {
  return generate(node, { compact: true, jsescOption: { quotes: 'single' } }).code;
}

/** Property key as a string, or null for computed/exotic keys. */
export function propName(p: t.ObjectProperty | t.ObjectMethod): string | null {
  if (p.computed) return null;
  if (t.isIdentifier(p.key)) return p.key.name;
  if (t.isStringLiteral(p.key)) return p.key.value;
  if (t.isNumericLiteral(p.key)) return String(p.key.value);
  return null;
}

function isDirnameOrCwd(node: t.Node): boolean {
  if (t.isIdentifier(node, { name: '__dirname' })) return true;
  // process.cwd()
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.object, { name: 'process' }) &&
    t.isIdentifier(node.callee.property, { name: 'cwd' })
  ) {
    return true;
  }
  return false;
}

/** True when a `path.resolve(...)` / `path.join(...)` call expression. */
function pathCallSegments(node: t.CallExpression): string[] | null {
  if (!t.isMemberExpression(node.callee)) return null;
  if (!t.isIdentifier(node.callee.object, { name: 'path' })) return null;
  if (
    !t.isIdentifier(node.callee.property, { name: 'resolve' }) &&
    !t.isIdentifier(node.callee.property, { name: 'join' })
  ) {
    return null;
  }
  const segments: string[] = [];
  for (const arg of node.arguments) {
    if (isDirnameOrCwd(arg)) {
      segments.push('.'); // anchor; callers usually only want the tail segments
      continue;
    }
    const r = evalNode(arg);
    if (!r.ok || typeof r.value !== 'string') return null;
    segments.push(r.value);
  }
  return segments;
}

/**
 * Resolve a node to a static JS value, or return { ok: false } when it cannot
 * be proven static.
 */
export function evalNode(node: t.Node): EvalResult {
  if (t.isStringLiteral(node)) return ok(node.value);
  if (t.isNumericLiteral(node)) return ok(node.value);
  if (t.isBooleanLiteral(node)) return ok(node.value);
  if (t.isNullLiteral(node)) return ok(null);

  if (t.isIdentifier(node)) {
    if (node.name === 'undefined') return ok(undefined);
    return err(`identifier '${node.name}' is not statically known`);
  }

  // -<number>
  if (t.isUnaryExpression(node) && node.operator === '-') {
    const inner = evalNode(node.argument);
    if (inner.ok && typeof inner.value === 'number') return ok(-inner.value);
    return err('non-numeric unary minus');
  }
  if (t.isUnaryExpression(node) && node.operator === '!') {
    const inner = evalNode(node.argument);
    if (inner.ok) return ok(!inner.value);
    return err('non-static unary not');
  }

  // Template literals without expressions: `foo`
  if (t.isTemplateLiteral(node)) {
    if (node.expressions.length === 0 && node.quasis.length === 1) {
      return ok(node.quasis[0]!.value.cooked ?? node.quasis[0]!.value.raw);
    }
    return err('template literal with expressions');
  }

  if (t.isArrayExpression(node)) {
    const out: unknown[] = [];
    for (const el of node.elements) {
      if (el == null) {
        out.push(undefined);
        continue;
      }
      if (t.isSpreadElement(el)) return err('spread in array');
      const r = evalNode(el);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  }

  if (t.isObjectExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const p of node.properties) {
      if (t.isSpreadElement(p)) return err('spread in object');
      if (t.isObjectMethod(p)) return err('object method');
      if (!t.isObjectProperty(p)) return err('exotic object member');
      const key = propName(p);
      if (key == null) return err('computed/exotic object key');
      const r = evalNode(p.value as t.Node);
      if (!r.ok) return r;
      out[key] = r.value;
    }
    return ok(out);
  }

  if (t.isCallExpression(node)) {
    // JSON.stringify(<literal>)
    if (
      t.isMemberExpression(node.callee) &&
      t.isIdentifier(node.callee.object, { name: 'JSON' }) &&
      t.isIdentifier(node.callee.property, { name: 'stringify' }) &&
      node.arguments.length >= 1
    ) {
      const r = evalNode(node.arguments[0] as t.Node);
      if (r.ok) {
        try {
          return ok(JSON.stringify(r.value));
        } catch {
          return err('JSON.stringify of non-serializable value');
        }
      }
      return err('JSON.stringify of non-static value');
    }
    // path.resolve / path.join over literals
    const segments = pathCallSegments(node);
    if (segments) {
      const joined = segments.filter((s) => s !== '.').join('/');
      return ok(joined.replace(/\/{2,}/g, '/'));
    }
    return err('non-allowlisted call expression');
  }

  if (t.isRegExpLiteral(node)) {
    return ok(new RegExp(node.pattern, node.flags));
  }

  if (t.isTSAsExpression(node) || t.isTSSatisfiesExpression(node)) {
    return evalNode(node.expression);
  }

  return err(`unsupported node type '${node.type}'`);
}

/** Convenience: resolve to a string or return null. */
export function evalString(node: t.Node): string | null {
  const r = evalNode(node);
  return r.ok && typeof r.value === 'string' ? r.value : null;
}

/** Convenience: resolve to a boolean or return null. */
export function evalBoolean(node: t.Node): boolean | null {
  const r = evalNode(node);
  return r.ok && typeof r.value === 'boolean' ? r.value : null;
}

/** Convenience: resolve to a number or return null. */
export function evalNumber(node: t.Node): number | null {
  const r = evalNode(node);
  return r.ok && typeof r.value === 'number' ? r.value : null;
}

/**
 * Does this subtree reference `env` or `argv` (the params webpack passes to a
 * function-form config)? Used to flag conditional config we can only read
 * statically.
 */
export function referencesEnvArgv(node: t.Node, paramNames: Set<string>): boolean {
  if (paramNames.size === 0) return false;
  let found = false;
  const visit = (n: t.Node | null | undefined): void => {
    if (!n || found) return;
    if (t.isIdentifier(n) && paramNames.has(n.name)) {
      found = true;
      return;
    }
    for (const key of Object.keys(n) as Array<keyof typeof n>) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') {
        continue;
      }
      const child = (n as unknown as Record<string, unknown>)[key as string];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c === 'object' && 'type' in c) visit(c as t.Node);
        }
      } else if (child && typeof child === 'object' && 'type' in (child as object)) {
        visit(child as t.Node);
      }
    }
  };
  visit(node);
  return found;
}
