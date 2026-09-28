import fs from 'node:fs';
import module from 'node:module';

import * as acorn from 'acorn';

export type ModuleFormat =
  | 'module'
  | 'commonjs'
  | 'json'
  | 'wasm'
  | 'addon'
  | 'builtin'
  | 'unsupported';

/** `ambiguous`: a `.js` file whose nearest package.json has no `"type"` field at all. */
export type DeclaredFormat = ModuleFormat | 'ambiguous';

/**
 * What the nearest controlling `package.json`'s `"type"` field says, without
 * looking at file content. `undefined` covers both "no package.json" and "no
 * `type` field" — in both cases Node's own behaviour is the same: fall back
 * to per-file syntax detection for `.js`, handled by `sniffAmbiguousJs` below.
 */
function packageType(fileUrl: string): 'module' | 'commonjs' | undefined {
  const pkgPath = module.findPackageJSON(fileUrl);
  if (!pkgPath) return undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    if (pkg.type === 'module') return 'module';
    if (pkg.type === 'commonjs') return 'commonjs';
    return undefined; // missing, or some unrecognised value: treated as absent.
  } catch {
    return undefined;
  }
}

/**
 * Format by extension and the controlling `package.json`'s `"type"` field
 * alone — no file content involved. Returns `'ambiguous'` for a `.js` file
 * with no `type` field anywhere above it (or no package.json at all): Node
 * itself does not know the format from metadata in that case either, and
 * resolves it by inspecting the file's syntax (`sniffAmbiguousJs`).
 */
export function declaredFormat(fileUrl: string): DeclaredFormat {
  if (fileUrl.startsWith('node:')) return 'builtin';
  if (fileUrl.endsWith('.mjs')) return 'module';
  if (fileUrl.endsWith('.cjs')) return 'commonjs';
  if (fileUrl.endsWith('.json')) return 'json';
  if (fileUrl.endsWith('.wasm')) return 'wasm';
  if (fileUrl.endsWith('.node')) return 'addon';
  if (!fileUrl.endsWith('.js')) return 'unsupported';

  return packageType(fileUrl) ?? 'ambiguous';
}

export interface SniffResult {
  /** `unknown`: parsed as neither a CommonJS script nor an ES module — a real syntax error. */
  format: 'module' | 'commonjs' | 'unknown';
  /** Set only when `format` is `unknown`. */
  parseError?: string;
}

/**
 * Node's own rule for a `.js` file with no `type` field (on by default since
 * 22.7, `--no-experimental-detect-module` to disable; see
 * https://nodejs.org/api/packages.html#determining-module-system): try to
 * evaluate it as CommonJS, and if that fails because the parser hit ES
 * module syntax — `import`/`export` statements, `import.meta`, or top-level
 * `await` — retry and load it as an ES module instead.
 *
 * Reproduced here as acorn parses instead of a real CommonJS evaluation:
 * first `sourceType: 'script'` (acorn rejects `import`/`export`/`import.meta`
 * there, and a bare top-level `await` fails for the same reason V8's CJS
 * wrapper rejects it — `await` is just an identifier outside an async
 * function, so `await x` parses as two adjacent expressions with no
 * operator). If that fails, `sourceType: 'module'` is tried next; success
 * means this is the ES module Node would load, matching the documented
 * trigger list for every case except one: lexically redeclaring
 * `require`/`module`/`exports`/`__dirname`/`__filename` at the top level is
 * syntactically valid either way (it only collides with the real CommonJS
 * function-wrapper parameters at evaluation time), so that specific trigger
 * is not detected here — see README Limitations.
 */
export function sniffAmbiguousJs(source: string, filename: string): SniffResult {
  try {
    acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', sourceFile: filename });
    return { format: 'commonjs' };
  } catch {
    // Fall through: the CJS parse failed, so Node would retry as a module.
  }
  try {
    acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', sourceFile: filename });
    return { format: 'module' };
  } catch (err) {
    // Parses as neither: a real syntax error, in either interpretation. Not
    // something to guess past — report it as unknown rather than claim `ok`.
    return { format: 'unknown', parseError: (err as Error).message };
  }
}
