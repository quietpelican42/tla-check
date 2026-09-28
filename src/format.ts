import fs from 'node:fs';
import module from 'node:module';

export type ModuleFormat =
  | 'module'
  | 'commonjs'
  | 'json'
  | 'wasm'
  | 'addon'
  | 'builtin'
  | 'unsupported';

/**
 * Determine how Node would load a resolved file: as an ES module, CommonJS,
 * JSON, WebAssembly, a native addon, or a built-in (`node:...`). For an
 * extensionless `.js` file this walks up to the nearest controlling
 * `package.json` via `module.findPackageJSON`, exactly as Node does, rather
 * than reimplementing that walk.
 */
export function detectFormat(fileUrl: string): ModuleFormat {
  if (fileUrl.startsWith('node:')) return 'builtin';
  if (fileUrl.endsWith('.mjs')) return 'module';
  if (fileUrl.endsWith('.cjs')) return 'commonjs';
  if (fileUrl.endsWith('.json')) return 'json';
  if (fileUrl.endsWith('.wasm')) return 'wasm';
  if (fileUrl.endsWith('.node')) return 'addon';
  if (!fileUrl.endsWith('.js')) return 'unsupported';

  const pkgPath = module.findPackageJSON(fileUrl);
  if (!pkgPath) return 'commonjs'; // Node's default when no package.json controls the file.
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    return pkg.type === 'module' ? 'module' : 'commonjs';
  } catch {
    return 'commonjs';
  }
}
