#!/usr/bin/env node
import { checkInstalled, checkPackage } from './index.ts';
import type { EntryResult, InstalledReport, PackageReport } from './types.ts';

interface Args {
  dir: string;
  installed: boolean;
  json: boolean;
  conditions: string[];
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: '.', installed: false, json: false, conditions: [], help: false };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--installed') args.installed = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--conditions') args.conditions.push(...(argv[++i] ?? '').split(',').filter(Boolean));
    else if (arg?.startsWith('--conditions=')) args.conditions.push(...arg.slice('--conditions='.length).split(',').filter(Boolean));
    else if (arg) positionals.push(arg);
  }
  if (positionals[0]) args.dir = positionals[0];
  return args;
}

const HELP = `tla-check [dir] [options]

Checks every entry point require() can reach in a package and reports
whether the ESM graph behind it contains a top-level await — the thing
that makes require() throw ERR_REQUIRE_ASYNC_MODULE on Node 22.12+/24.

Options:
  --installed          Walk node_modules of the project at [dir] instead,
                        and report which dependencies can't be require()d.
  --conditions <list>  Extra export conditions to consider, comma-separated
                        or repeated (e.g. --conditions browser).
  --json                Print machine-readable JSON instead of text.
  -h, --help            Show this help.

Exit codes: 0 clean, 1 findings, 2 could not analyse.
`;

function formatEntry(e: EntryResult): string {
  const label = `  ${e.specifier} (${e.condition})`;
  if (e.status === 'ok') return `${label}: ok${e.resolvedFile ? ` -> ${e.resolvedFile}` : ''}`;
  if (e.status === 'unresolved') return `${label}: UNKNOWN — ${e.error ?? e.warnings.join('; ')}`;
  if (e.status === 'unsupported') return `${label}: UNKNOWN — ${e.error ?? 'unsupported file type'}`;
  const lines = [`${label}: FAILS require() — top-level await found`];
  for (const a of e.awaits) {
    lines.push(`    at ${a.location.url}:${a.location.line}:${a.location.column}`);
    lines.push(`      ${a.location.sourceLine}`);
    lines.push(`    chain: ${a.chain.map((c) => shortUrl(c.url)).join(' -> ')}`);
  }
  return lines.join('\n');
}

function shortUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

function printPackageReport(report: PackageReport): void {
  if (report.fatalError) {
    console.error(`error: ${report.fatalError}`);
    return;
  }
  console.log(`${report.name ?? report.dir}${report.version ? `@${report.version}` : ''}`);
  for (const e of report.entries) console.log(formatEntry(e));
}

function printInstalledReport(report: InstalledReport): void {
  if (report.fatalError) {
    console.error(`error: ${report.fatalError}`);
    return;
  }
  for (const dep of report.dependencies) {
    if (dep.error) {
      console.log(`${dep.name}: UNKNOWN — ${dep.error}`);
      continue;
    }
    const r = dep.report!;
    if (r.fatalError) {
      console.log(`${dep.name}@${dep.version ?? '?'}: UNKNOWN — ${r.fatalError}`);
      continue;
    }
    const bad = r.entries.filter((e) => e.status === 'top-level-await');
    const unknown = r.entries.filter((e) => e.status === 'unresolved' || e.status === 'unsupported');
    if (bad.length > 0) {
      console.log(`${dep.name}@${dep.version ?? '?'}: FAILS require() — top-level await`);
      for (const e of bad) console.log(formatEntry(e));
    } else if (unknown.length > 0) {
      console.log(`${dep.name}@${dep.version ?? '?'}: UNKNOWN — ${unknown.map((e) => e.error).join('; ')}`);
    } else {
      console.log(`${dep.name}@${dep.version ?? '?'}: ok`);
    }
  }
}

function exitCodeFor(entries: EntryResult[], fatalError: string | undefined): number {
  if (fatalError) return 2;
  if (entries.some((e) => e.status === 'top-level-await')) return 1;
  if (entries.some((e) => e.status === 'unresolved' || e.status === 'unsupported')) return 2;
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.installed) {
    const report = await checkInstalled(args.dir, { conditions: args.conditions });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printInstalledReport(report);

    if (report.fatalError) process.exit(2);
    const allEntries = report.dependencies.flatMap((d) => d.report?.entries ?? []);
    const anyDepError = report.dependencies.some((d) => d.error || d.report?.fatalError);
    process.exit(exitCodeFor(allEntries, anyDepError ? 'x' : undefined));
    return;
  }

  const report = await checkPackage(args.dir, { conditions: args.conditions });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printPackageReport(report);
  process.exit(exitCodeFor(report.entries, report.fatalError));
}

main().catch((err) => {
  console.error(`tla-check: unexpected error: ${(err as Error).stack ?? err}`);
  process.exit(2);
});
