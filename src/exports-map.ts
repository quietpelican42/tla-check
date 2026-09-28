import fs from 'node:fs';
import path from 'node:path';

export interface RawEntry {
  specifier: string;
  condition: string;
  /** Absolute file path, or undefined if this subpath resolved to `null` (explicitly blocked) or nothing matched. */
  file?: string;
  /** Set when the subpath is a pattern (`./feature/*`) and no files matched it. */
  note?: string;
}

/**
 * The conditions Node consults, in order, when `require()` resolves a
 * package's `exports` map. `import` is deliberately excluded: that is the
 * one condition transitive `import` specifiers inside the graph use instead
 * (verified empirically — see README "How it works").
 */
function activeConditions(extra: string[]): Set<string> {
  return new Set(['node', 'require', ...extra]);
}

/**
 * Enumerate every subpath `require()` can reach for this package, following
 * Node's package `exports` resolution algorithm (or the legacy `main` field
 * when there is no `exports` map).
 */
export function resolveRequireEntryPoints(packageDir: string, extraConditions: string[]): RawEntry[] {
  const pkgPath = path.join(packageDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  const active = activeConditions(extraConditions);

  if (pkg.exports !== undefined) {
    return resolveExportsField(packageDir, pkg.exports, active);
  }
  return resolveMainField(packageDir, pkg);
}

function resolveExportsField(packageDir: string, exportsField: unknown, active: Set<string>): RawEntry[] {
  const entries: RawEntry[] = [];

  // A bare string or a conditions object (keys are condition names, not subpaths) both mean ".".
  if (
    typeof exportsField === 'string' ||
    Array.isArray(exportsField) ||
    exportsField === null ||
    typeof exportsField !== 'object' ||
    !isSubpathMap(exportsField)
  ) {
    const { file, condition } = matchConditions(exportsField, active);
    entries.push({ specifier: '.', condition, file: file ? resolveTarget(packageDir, file) : undefined });
    return entries;
  }

  const map = exportsField as Record<string, unknown>;
  for (const subpath of Object.keys(map)) {
    const target = map[subpath];
    if (subpath.includes('*')) {
      entries.push(...resolvePattern(packageDir, subpath, target, active));
      continue;
    }
    const { file, condition } = matchConditions(target, active);
    entries.push({ specifier: subpath, condition, file: file ? resolveTarget(packageDir, file) : undefined });
  }
  return entries;
}

/** True if every key is a subpath (`.` or `./...`) rather than a condition name. */
function isSubpathMap(obj: object): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 0) return true;
  return keys.every((k) => k === '.' || k.startsWith('./'));
}

/**
 * Walk a target (string | array | conditions object | null), matching
 * conditions in the key order Node uses: first key that is `default` or is
 * in the active set wins, recursing into nested condition objects.
 */
function matchConditions(target: unknown, active: Set<string>): { file?: string; condition: string } {
  if (target === null) return { condition: 'null (explicitly excluded)' };
  if (typeof target === 'string') return { file: target, condition: '(direct target)' };
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const result = matchConditions(candidate, active);
      if (result.file) return result;
    }
    return { condition: '(no array candidate resolved)' };
  }
  if (typeof target === 'object') {
    for (const [key, value] of Object.entries(target as Record<string, unknown>)) {
      if (key === 'default' || active.has(key)) {
        const result = matchConditions(value, active);
        if (result.file || value === null) return { file: result.file, condition: key };
      }
    }
    return { condition: '(no condition matched)' };
  }
  return { condition: '(unsupported target type)' };
}

function resolveTarget(packageDir: string, target: string): string {
  return path.resolve(packageDir, target);
}

/**
 * Expand a single-`*` subpath pattern (e.g. `./feature/*` -> `./dist/feature/*.js`)
 * by scanning the target directory for files that fit the pattern's suffix/prefix.
 * `*` matches the remainder of the path, including `/`, same as Node.
 */
function resolvePattern(
  packageDir: string,
  subpathPattern: string,
  target: unknown,
  active: Set<string>,
): RawEntry[] {
  const { file: targetPattern } = matchConditions(target, active);
  if (!targetPattern || !targetPattern.includes('*')) {
    return [{ specifier: subpathPattern, condition: '(pattern)', note: 'target is not a matching pattern' }];
  }
  const [prefix, suffix] = targetPattern.split('*');
  // Split "prefix" into its directory part and leftover filename prefix by hand:
  // path.dirname/basename mishandle a prefix that ends in "/" (the common case),
  // treating the last directory segment as a basename instead of an empty one.
  const slashIdx = (prefix ?? '').lastIndexOf('/');
  const dirPart = slashIdx >= 0 ? (prefix ?? '').slice(0, slashIdx + 1) : '';
  const filePrefix = slashIdx >= 0 ? (prefix ?? '').slice(slashIdx + 1) : (prefix ?? '');
  const scanRoot = path.resolve(packageDir, dirPart || '.');

  const matches: string[] = [];
  walkDir(scanRoot, (absFile) => {
    const rel = path.relative(scanRoot, absFile).split(path.sep).join('/');
    if (rel.startsWith(filePrefix) && rel.endsWith(suffix ?? '')) {
      const wildcard = rel.slice(filePrefix.length, rel.length - (suffix ?? '').length);
      matches.push(wildcard);
    }
  });

  if (matches.length === 0) {
    return [{ specifier: subpathPattern, condition: '(pattern)', note: `no files under ${scanRoot} matched` }];
  }

  const [subPrefix, subSuffix] = subpathPattern.split('*');
  return matches.map((wildcard) => ({
    specifier: `${subPrefix}${wildcard}${subSuffix ?? ''}`,
    condition: '(pattern)',
    file: path.join(scanRoot, filePrefix + wildcard + (suffix ?? '')),
  }));
}

function walkDir(dir: string, onFile: (absPath: string) => void): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) walkDir(abs, onFile);
    else if (stat.isFile()) onFile(abs);
  }
}

/** Legacy resolution used when a package has no `exports` map: just `main` (or `./index.js`). */
function resolveMainField(packageDir: string, pkg: Record<string, unknown>): RawEntry[] {
  const candidate = typeof pkg.main === 'string' ? pkg.main : './index.js';
  const resolved = resolveAsFileOrIndex(packageDir, candidate);
  return [{ specifier: '.', condition: 'main', file: resolved }];
}

const CJS_LOAD_EXTENSIONS = ['', '.js', '.json', '.node', '.mjs', '.cjs'];

function resolveAsFileOrIndex(packageDir: string, candidate: string): string | undefined {
  const base = path.resolve(packageDir, candidate);
  for (const ext of CJS_LOAD_EXTENSIONS) {
    const file = base + ext;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  for (const ext of ['.js', '.json', '.node', '.mjs', '.cjs']) {
    const file = path.join(base, 'index' + ext);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return undefined;
}
