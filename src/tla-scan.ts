import * as acorn from 'acorn';
import type { Node } from 'acorn';

export interface StaticEdge {
  specifier: string;
  kind: 'import' | 'export-from';
}

export interface ScanResult {
  topLevelAwaits: Array<{ line: number; column: number; sourceLine: string }>;
  edges: StaticEdge[];
}

/** Node types that introduce a new function scope: `await` inside them is not top-level. */
const FUNCTION_BOUNDARY = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/**
 * Parse a module's source with acorn and find:
 *  - every top-level `await` (including `for await (...)`), i.e. one that
 *    would make `require()` throw ERR_REQUIRE_ASYNC_MODULE for this module
 *    or anything that imports it;
 *  - every static import edge: `import ... from 'x'` and `export ... from 'x'`
 *    (both count toward the graph `require()` must resolve). Dynamic
 *    `import('x')` is deliberately NOT collected — verified empirically that
 *    it does not make `require()` throw, since it is evaluated lazily/async
 *    and does not block synchronous linking.
 */
export function scanModule(source: string, filename: string): ScanResult {
  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowImportExportEverywhere: false,
    locations: true,
    sourceFile: filename,
  }) as unknown as Node & { body: Node[] };

  const topLevelAwaits: ScanResult['topLevelAwaits'] = [];
  const edges: StaticEdge[] = [];
  const lines = source.split('\n');

  const recordAwait = (node: Node): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loc = (node as any).loc;
    const line = loc?.start?.line ?? 0;
    const column = loc?.start?.column ?? 0;
    topLevelAwaits.push({ line, column, sourceLine: (lines[line - 1] ?? '').trim() });
  };

  // Generic recursive descent over the acorn AST that stops at function
  // boundaries (top-level await cannot appear inside a nested function) and
  // records AwaitExpression / `for await` nodes anywhere else.
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const n = node as Node & Record<string, unknown>;
    if (typeof n.type !== 'string') return;

    if (n.type === 'AwaitExpression') {
      recordAwait(n);
      // still walk its argument: `await (await x)` etc.
    }
    if (n.type === 'ForOfStatement' && (n as unknown as { await?: boolean }).await) {
      recordAwait(n);
    }
    if (FUNCTION_BOUNDARY.has(n.type)) {
      return; // do not descend: nothing inside can be a top-level await
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'type') continue;
      visit((n as Record<string, unknown>)[key]);
    }
  };

  for (const stmt of ast.body) {
    const s = stmt as Node & Record<string, unknown>;
    if (s.type === 'ImportDeclaration') {
      const source = s.source as { value?: unknown } | undefined;
      if (typeof source?.value === 'string') edges.push({ specifier: source.value, kind: 'import' });
      continue; // import declarations contain no executable await
    }
    if (s.type === 'ExportNamedDeclaration' && s.source) {
      const source = s.source as { value?: unknown };
      if (typeof source.value === 'string') edges.push({ specifier: source.value, kind: 'export-from' });
      continue;
    }
    if (s.type === 'ExportAllDeclaration') {
      const source = s.source as { value?: unknown };
      if (typeof source.value === 'string') edges.push({ specifier: source.value, kind: 'export-from' });
      continue;
    }
    visit(stmt);
  }

  return { topLevelAwaits, edges };
}
