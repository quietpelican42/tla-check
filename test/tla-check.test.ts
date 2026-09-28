import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { checkPackage } from '../src/index.ts';
import type { EntryResult, PackageReport } from '../src/types.ts';
import { realRequireVerdict } from './ground-truth.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function entry(report: PackageReport, specifier = '.'): EntryResult {
  const e = report.entries.find((x) => x.specifier === specifier);
  assert.ok(e, `no entry for specifier "${specifier}" in ${JSON.stringify(report.entries.map((x) => x.specifier))}`);
  return e;
}

/** Cross-checks the tool's verdict for one entry against a real require() of its resolved file. */
function assertMatchesRealNode(e: EntryResult): void {
  assert.ok(e.resolvedFile, 'entry has no resolvedFile to check against real require()');
  const truth = realRequireVerdict(e.resolvedFile!);
  if (truth.requirable !== undefined) {
    assert.equal(
      e.requirable,
      truth.requirable,
      `tool said requirable=${e.requirable} but real require() ${truth.requirable ? 'succeeded' : 'threw ERR_REQUIRE_ASYNC_MODULE'}`,
    );
  } else {
    // Real require() failed for a reason other than TLA (e.g. module not found).
    // The tool must not claim 'ok' — 'unresolved' or 'unsupported' is correct, 'top-level-await' would be wrong.
    assert.notEqual(e.status, 'ok', `tool said ok but real require() failed: ${truth.otherErrorCode}`);
    assert.notEqual(e.status, 'top-level-await', `tool blamed TLA but real require() failed differently: ${truth.otherErrorCode}`);
  }
}

describe('ground truth: every fixture entry matches a real require()', () => {
  const cases: Array<{ fixture: string; specifier?: string }> = [
    { fixture: 'ok-plain-cjs' },
    { fixture: 'ok-esm-no-tla' },
    { fixture: 'direct-tla' },
    { fixture: 'tla-via-import' },
    { fixture: 'tla-via-export-from' },
    { fixture: 'deep-chain' },
    { fixture: 'dynamic-import-not-counted' },
    { fixture: 'cjs-stop-descent' },
    { fixture: 'json-import' },
    { fixture: 'dual-conditions-require-clean' },
    { fixture: 'dual-conditions-require-has-tla' },
    { fixture: 'subpath-exports', specifier: '.' },
    { fixture: 'subpath-exports', specifier: './clean' },
    { fixture: 'subpath-exports', specifier: './broken' },
    { fixture: 'pattern-exports', specifier: './features/alpha' },
    { fixture: 'pattern-exports', specifier: './features/beta' },
    { fixture: 'main-fallback-index' },
    { fixture: 'mjs-extension-override' },
    { fixture: 'cjs-extension-override' },
    { fixture: 'node-builtin-import' },
    { fixture: 'ambiguous-tla-no-type' },
    { fixture: 'ambiguous-dual-conditions' },
    { fixture: 'explicit-commonjs-type' },
    { fixture: 'ambiguous-plain-cjs' },
    { fixture: 'self-reference-import' },
  ];

  for (const { fixture, specifier } of cases) {
    test(`${fixture}${specifier ? ` ${specifier}` : ''}`, async () => {
      const report = await checkPackage(path.join(FIXTURES, fixture));
      assert.equal(report.fatalError, undefined, `unexpected fatal error: ${report.fatalError}`);
      assertMatchesRealNode(entry(report, specifier));
    });
  }
});

describe('specific behaviour', () => {
  test('reports the full import chain to a top-level await several hops deep', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'deep-chain'));
    const e = entry(report);
    assert.equal(e.status, 'top-level-await');
    assert.equal(e.awaits.length, 1);
    const chain = e.awaits[0]!.chain;
    assert.equal(chain.length, 3, `expected entry -> mid-dep -> leaf-dep, got ${chain.map((c) => c.url).join(' -> ')}`);
    assert.ok(chain[0]!.url.endsWith('deep-chain/index.js'));
    assert.ok(chain[2]!.url.includes('leaf-dep'));
  });

  test('does not follow dynamic import() as a graph edge', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'dynamic-import-not-counted'));
    const e = entry(report);
    assert.equal(e.status, 'ok');
    assert.equal(e.requirable, true);
  });

  test('stops descending at a CJS file reached via import', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'cjs-stop-descent'));
    const e = entry(report);
    assert.equal(e.status, 'ok');
  });

  test('a require-branch TLA is caught even when the import branch is clean', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'dual-conditions-require-has-tla'));
    const e = entry(report);
    assert.equal(e.status, 'top-level-await');
    assert.equal(e.condition, 'require');
  });

  test('a require-branch that is clean is not flagged even when the import branch has TLA', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'dual-conditions-require-clean'));
    const e = entry(report);
    assert.equal(e.status, 'ok');
    assert.equal(e.condition, 'require');
  });

  test('a .js file with no "type" field anywhere above it is sniffed for real ESM syntax, not assumed CommonJS', async () => {
    // Regression: Node's own module-syntax detection (default on since 22.7)
    // loads such a file as ESM if it contains ESM-only syntax, even with no
    // "type" field at all. The tool used to classify these as CommonJS from
    // the missing field alone and silently stop descent — a false negative.
    const report = await checkPackage(path.join(FIXTURES, 'ambiguous-tla-no-type'));
    const e = entry(report);
    assert.equal(e.status, 'top-level-await');
    assert.equal(e.requirable, false);
  });

  test('the same ambiguous-detection sniff applies several hops into a dependency with no "type" field', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'ambiguous-dual-conditions'));
    const e = entry(report);
    assert.equal(e.status, 'top-level-await');
    const chain = e.awaits[0]!.chain;
    assert.equal(chain.length, 3, `expected index.js -> dep/esm.js -> dep/deep.js, got ${chain.map((c) => c.url).join(' -> ')}`);
    assert.ok(chain[2]!.url.endsWith('dep/deep.js'));
  });

  test('explicit "type": "commonjs" disables ambiguous-file detection entirely', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'explicit-commonjs-type'));
    assert.equal(entry(report).status, 'ok');
  });

  test('an ambiguous .js file with genuinely plain CommonJS content is not a false positive', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'ambiguous-plain-cjs'));
    assert.equal(entry(report).status, 'ok');
  });

  test('expands a subpath export pattern into one entry per matching file', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'pattern-exports'));
    assert.equal(report.entries.length, 2);
    assert.equal(entry(report, './features/alpha').status, 'ok');
    assert.equal(entry(report, './features/beta').status, 'top-level-await');
  });

  test('reports an unresolved dependency as unknown, not ok and not a TLA finding', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'unresolved-dependency'));
    const e = entry(report);
    assert.equal(e.status, 'unresolved');
    assert.equal(e.requirable, undefined);
  });

  test('checkPackage reports a fatal error for a missing directory', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'does-not-exist'));
    assert.ok(report.fatalError);
    assert.equal(report.clean, false);
  });

  test('negative control: a clean package reports every entry ok and clean=true', async () => {
    const report = await checkPackage(path.join(FIXTURES, 'ok-esm-no-tla'));
    assert.equal(report.clean, true);
    assert.equal(report.hasFindings, false);
    for (const e of report.entries) assert.equal(e.status, 'ok');
  });
});
