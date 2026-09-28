/**
 * Runs as a child `node` process, spawned with `--conditions=<c>` for every
 * extra condition the caller asked for. That is the only way to make
 * `import.meta.resolve` — which this module uses for every transitive
 * resolution — honour custom conditions, since they are a process-startup
 * flag in Node, not something selectable per call.
 *
 * This module never imports or executes anything in the target package: it
 * only resolves specifiers (`import.meta.resolve`) and reads+parses source
 * text (`fs.readFileSync` + acorn). No target code runs.
 */
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveRequireEntryPoints } from './exports-map.ts';
import { detectFormat } from './format.ts';
import { scanModule } from './tla-scan.ts';
import type { ChainLink, EntryResult, PackageReport, TlaLocation } from './types.ts';

interface WorkerInput {
  packageDir: string;
  conditions: string[];
}

type WalkOutcome = Pick<EntryResult, 'awaits' | 'warnings' | 'status' | 'requirable' | 'error'>;

function walkEntry(entryFile: string): WalkOutcome {
  const entryUrl = pathToFileURL(entryFile).href;
  const format = detectFormat(entryUrl);

  if (format !== 'module') {
    if (format === 'unsupported') {
      return {
        status: 'unsupported',
        requirable: undefined,
        awaits: [],
        warnings: [],
        error: `unrecognised file type for ${entryFile}`,
      };
    }
    // commonjs / json / wasm / addon / builtin: require()-able directly, no TLA graph to walk.
    return { status: 'ok', requirable: true, awaits: [], warnings: [] };
  }

  const visited = new Set<string>();
  const queue: Array<{ url: string; chain: ChainLink[] }> = [
    { url: entryUrl, chain: [{ url: entryUrl, via: 'entry' }] },
  ];
  const awaits: Array<{ location: TlaLocation; chain: ChainLink[] }> = [];
  const blocked: string[] = [];
  const notes: string[] = [];

  while (queue.length > 0) {
    const { url, chain } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const fmt = detectFormat(url);
    if (fmt !== 'module') {
      if (fmt === 'wasm' || fmt === 'addon') {
        notes.push(`reached a ${fmt} module at ${url}; not statically analysable, treated as a dead end`);
      } else if (fmt === 'unsupported') {
        notes.push(`unrecognised file type at ${url}; treated as a dead end`);
      }
      // commonjs / json / builtin: stop descent — verified empirically that a CJS
      // module reached via `import` is a hard boundary require() does not see past.
      continue;
    }

    let source: string;
    try {
      source = fs.readFileSync(fileURLToPath(url), 'utf8');
    } catch (err) {
      blocked.push(`could not read ${url}: ${(err as Error).message}`);
      continue;
    }

    let scan;
    try {
      scan = scanModule(source, fileURLToPath(url));
    } catch (err) {
      blocked.push(`could not parse ${url}: ${(err as Error).message}`);
      continue;
    }

    for (const tla of scan.topLevelAwaits) {
      awaits.push({
        location: { url, line: tla.line, column: tla.column, sourceLine: tla.sourceLine },
        chain,
      });
    }

    for (const edge of scan.edges) {
      let resolved: string;
      try {
        // Verified empirically: sub-imports inside a require()'d ESM graph resolve
        // using the `import` condition, not `require` — even though the graph was
        // reached via require(). import.meta.resolve does exactly that resolution.
        resolved = import.meta.resolve(edge.specifier, url);
      } catch (err) {
        blocked.push(`cannot resolve "${edge.specifier}" from ${url}: ${(err as Error).message}`);
        continue;
      }
      queue.push({
        url: resolved,
        chain: [...chain, { url: resolved, via: edge.kind, specifier: edge.specifier }],
      });
    }
  }

  if (awaits.length > 0) {
    return { status: 'top-level-await', requirable: false, awaits, warnings: [...blocked, ...notes] };
  }
  if (blocked.length > 0) {
    return { status: 'unresolved', requirable: undefined, awaits: [], warnings: [...blocked, ...notes] };
  }
  return { status: 'ok', requirable: true, awaits: [], warnings: notes };
}

function main(): void {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('worker: missing input file argument');
    process.exit(2);
  }
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as WorkerInput;

  const report: PackageReport = {
    dir: input.packageDir,
    conditions: input.conditions,
    entries: [],
    clean: true,
    hasFindings: false,
  };

  let pkg: Record<string, unknown> | undefined;
  try {
    pkg = JSON.parse(fs.readFileSync(`${input.packageDir}/package.json`, 'utf8')) as Record<string, unknown>;
    report.name = typeof pkg.name === 'string' ? pkg.name : undefined;
    report.version = typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch (err) {
    report.fatalError = `could not read package.json in ${input.packageDir}: ${(err as Error).message}`;
    process.stdout.write(JSON.stringify(report));
    return;
  }

  let rawEntries;
  try {
    rawEntries = resolveRequireEntryPoints(input.packageDir, input.conditions);
  } catch (err) {
    report.fatalError = `could not resolve entry points: ${(err as Error).message}`;
    process.stdout.write(JSON.stringify(report));
    return;
  }

  for (const raw of rawEntries) {
    if (!raw.file) {
      report.entries.push({
        specifier: raw.specifier,
        condition: raw.condition,
        status: 'unresolved',
        requirable: undefined,
        awaits: [],
        warnings: [],
        error: raw.note ?? `no export condition matched for "${raw.specifier}"`,
      });
      continue;
    }
    if (!fs.existsSync(raw.file)) {
      report.entries.push({
        specifier: raw.specifier,
        condition: raw.condition,
        resolvedFile: raw.file,
        status: 'unresolved',
        requirable: undefined,
        awaits: [],
        warnings: [],
        error: `resolved to ${raw.file}, which does not exist`,
      });
      continue;
    }
    const walked = walkEntry(raw.file);
    report.entries.push({
      specifier: raw.specifier,
      condition: raw.condition,
      resolvedFile: raw.file,
      ...walked,
    });
  }

  report.clean = report.entries.every((e) => e.status === 'ok');
  report.hasFindings = report.entries.some((e) => e.status === 'top-level-await');

  process.stdout.write(JSON.stringify(report));
}

main();
