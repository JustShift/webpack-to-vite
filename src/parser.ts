/**
 * Parse a webpack config and extract its static config object.
 *
 * Supported input shapes:
 *   module.exports = { ... }
 *   module.exports = config            (resolve const config = { ... })
 *   export default { ... }
 *   export default defineConfig({ ... })
 *   module.exports = (env, argv) => ({ ... })   (function-form, NOT executed)
 *   module.exports = function () { return { ... } }
 *   module.exports = [ {...}, {...} ]            (multi-config array; first used)
 *
 * Function-form configs are never executed. We read the returned object literal
 * statically and, if it references the function's `env`/`argv` params, flag it.
 */
import * as parser from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { referencesEnvArgv } from './static-eval.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse: any =
  typeof _traverse === 'function'
    ? _traverse
    : (_traverse as unknown as { default: unknown }).default;

export interface ParseOutcome {
  configObject: t.ObjectExpression | null;
  usedFunctionForm: boolean;
  dependsOnEnvArgv: boolean;
  multiConfigArray: boolean;
  parseError: string | null;
}

export function parseWebpackConfig(input: string): ParseOutcome {
  let ast: parser.ParseResult<t.File>;
  try {
    ast = parser.parse(input, {
      sourceType: 'unambiguous',
      plugins: ['typescript', 'jsx'],
    });
  } catch (e) {
    return {
      configObject: null,
      usedFunctionForm: false,
      dependsOnEnvArgv: false,
      multiConfigArray: false,
      parseError: e instanceof Error ? e.message : String(e),
    };
  }

  let configObject: t.ObjectExpression | null = null;
  let usedFunctionForm = false;
  let dependsOnEnvArgv = false;
  let multiConfigArray = false;

  // Pull the object literal out of a function-form config without executing it.
  const fromFunction = (fn: t.ArrowFunctionExpression | t.FunctionExpression): t.ObjectExpression | null => {
    usedFunctionForm = true;
    const paramNames = new Set<string>();
    for (const param of fn.params) {
      if (t.isIdentifier(param)) paramNames.add(param.name);
      // destructured params like ({ production }) — treat each bound name as env-ish
      else if (t.isObjectPattern(param)) {
        for (const pr of param.properties) {
          if (t.isObjectProperty(pr) && t.isIdentifier(pr.value)) paramNames.add(pr.value.name);
        }
      }
    }

    let obj: t.ObjectExpression | null = null;
    if (t.isObjectExpression(fn.body)) {
      obj = fn.body;
    } else if (t.isBlockStatement(fn.body)) {
      const returns = fn.body.body.filter((s): s is t.ReturnStatement => t.isReturnStatement(s));
      if (returns.length >= 1 && returns[0]!.argument) {
        obj = unwrap(returns[0]!.argument);
      }
    }
    if (obj && referencesEnvArgv(obj, paramNames)) dependsOnEnvArgv = true;
    return obj;
  };

  // Reduce an expression to a config object literal where possible.
  const unwrap = (node: t.Node | null | undefined): t.ObjectExpression | null => {
    if (!node) return null;
    if (t.isObjectExpression(node)) return node;
    if (t.isTSAsExpression(node) || t.isTSSatisfiesExpression(node)) return unwrap(node.expression);
    // defineConfig({...}) / merge(base, {...}) — find the first object argument
    // (webpack-merge often puts the literal override after a base identifier).
    if (t.isCallExpression(node)) {
      for (const a of node.arguments) {
        if (t.isObjectExpression(a)) return a;
      }
      for (const a of node.arguments) {
        if (t.isArrowFunctionExpression(a) || t.isFunctionExpression(a)) return fromFunction(a);
      }
      return null;
    }
    if (t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)) return fromFunction(node);
    // module.exports = [config1, config2] — analyze the first config.
    if (t.isArrayExpression(node)) {
      const first = node.elements.find((e): e is t.Expression => e != null && !t.isSpreadElement(e));
      if (first) {
        multiConfigArray = true;
        return unwrap(first);
      }
    }
    return null;
  };

  traverse(ast, {
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      if (configObject) return;
      const { left, right } = path.node;
      const isModuleExports =
        t.isMemberExpression(left) &&
        t.isIdentifier(left.object, { name: 'module' }) &&
        t.isIdentifier(left.property, { name: 'exports' });
      if (!isModuleExports) return;

      const direct = unwrap(right);
      if (direct) {
        configObject = direct;
        return;
      }
      // module.exports = configIdentifier -> resolve a const declaration.
      if (t.isIdentifier(right)) {
        const binding = path.scope.getBinding(right.name);
        if (binding && t.isVariableDeclarator(binding.path.node)) {
          const fromInit = unwrap(binding.path.node.init);
          if (fromInit) configObject = fromInit;
        }
      }
    },
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      if (configObject) return;
      const decl = path.node.declaration;
      const direct = unwrap(decl as t.Node);
      if (direct) {
        configObject = direct;
        return;
      }
      if (t.isIdentifier(decl)) {
        const binding = path.scope.getBinding(decl.name);
        if (binding && t.isVariableDeclarator(binding.path.node)) {
          const fromInit = unwrap(binding.path.node.init);
          if (fromInit) configObject = fromInit;
        }
      }
    },
  });

  return { configObject, usedFunctionForm, dependsOnEnvArgv, multiConfigArray, parseError: null };
}
