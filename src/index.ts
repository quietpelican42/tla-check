import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CheckOptions, EntryResult, InstalledDependencyResult, InstalledReport, PackageReport } from './types.ts';

export type {
  CheckOptions,
  ChainLink,
  EntryResult,
  EntryStatus,
  InstalledDependencyResult,
  InstalledReport,
  PackageReport,
  TlaLocation,
} from './types.ts';

/** Same extension as this module's own file, so the worker is found in both `src/*.ts` and built `dist/*.js`. */
function workerUrl(): URL {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./worker${ext}`, import.meta.url);
}

/**
 * For every entry point `require()` can reach in this package (its `exports`
 * map, or `main`), resolve the ESM graph the way Node does and report any
 * top-level `await` reachable from it — the thing that makes `require()`
 * throw `ERR_REQUIRE_ASYNC_MODULE`.
 *
 * Runs the actual graph walk in a child `node` process, started with
 * `--conditions=<c>` for each of `options.conditions`: that is the only way
 * to make `import.meta.resolve`, which does the transitive resolution, honour
 * custom conditions, since conditions are a process-startup flag in Node.
 * The child process never imports or executes the target package's code.
 */
export async function checkPackage(dir: string, options: CheckOptions = {}): Promise<PackageReport> {
  const packageDir = path.resolve(dir);
  const conditions = options.conditions ?? [];

  if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
    return {
      dir: packageDir,
      conditions,
      entries: [],
      clean: false,
      hasFindings: false,
      fatalError: `no package.json in ${packageDir}`,
    };
  }

  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tla-check-')), 'input.json');
  fs.writeFileSync(tmpFile, JSON.stringify({ packageDir, conditions }));

  try {
    const args = [
      // Without this flag, import.meta.resolve(specifier, parent) silently
      // ignores `parent` and resolves against the current working directory
      // instead — verified empirically. The worker needs the real parent to
      // walk the graph correctly.
      '--experimental-import-meta-resolve',
      ...conditions.map((c) => `--conditions=${c}`),
      fileURLPath(workerUrl()),
      tmpFile,
    ];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

    if (result.error) {
      return {
        dir: packageDir,
        conditions,
        entries: [],
        clean: false,
        hasFindings: false,
        fatalError: `failed to spawn worker: ${result.error.message}`,
      };
    }
    if (!result.stdout || result.stdout.trim() === '') {
      return {
        dir: packageDir,
        conditions,
        entries: [],
        clean: false,
        hasFindings: false,
        fatalError: `worker produced no output (exit ${result.status}): ${result.stderr}`,
      };
    }
    return JSON.parse(result.stdout) as PackageReport;
  } finally {
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  }
}

function fileURLPath(url: URL): string {
  return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : url.toString();
}

/**
 * Walk `node_modules` of a project (its direct `dependencies`,
 * `devDependencies`, `optionalDependencies` and `peerDependencies`) and
 * report which ones can't be `require()`d — i.e. `checkPackage` for each
 * installed dependency's default entry point.
 */
export async function checkInstalled(dir: string, options: CheckOptions = {}): Promise<InstalledReport> {
  const projectDir = path.resolve(dir);
  const pkgPath = path.join(projectDir, 'package.json');
  const nodeModules = path.join(projectDir, 'node_modules');

  if (!fs.existsSync(pkgPath)) {
    return { dir: projectDir, dependencies: [], clean: false, hasFindings: false, fatalError: `no package.json in ${projectDir}` };
  }
  if (!fs.existsSync(nodeModules)) {
    return {
      dir: projectDir,
      dependencies: [],
      clean: false,
      hasFindings: false,
      fatalError: `no node_modules in ${projectDir} — run npm install first`,
    };
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps as Record<string, unknown>)) names.add(name);
    }
  }

  const dependencies: InstalledDependencyResult[] = [];
  for (const name of [...names].sort()) {
    const depDir = path.join(nodeModules, ...name.split('/'));
    if (!fs.existsSync(path.join(depDir, 'package.json'))) {
      dependencies.push({ name, dir: depDir, error: 'not installed (missing from node_modules)' });
      continue;
    }
    let version: string | undefined;
    try {
      const depPkg = JSON.parse(fs.readFileSync(path.join(depDir, 'package.json'), 'utf8')) as Record<string, unknown>;
      version = typeof depPkg.version === 'string' ? depPkg.version : undefined;
    } catch {
      // fall through with version undefined; checkPackage will report the fatal error
    }
    const report = await checkPackage(depDir, options);
    dependencies.push({ name, version, dir: depDir, report });
  }

  return {
    dir: projectDir,
    dependencies,
    clean: dependencies.every((d) => !d.error && d.report?.clean),
    hasFindings: dependencies.some((d) => d.report?.hasFindings),
  };
}

/** Every entry across a report that is a confirmed top-level-await finding. */
export function findings(report: PackageReport): EntryResult[] {
  return report.entries.filter((e) => e.status === 'top-level-await');
}
