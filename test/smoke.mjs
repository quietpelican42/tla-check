/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { checkPackage } = await import('../dist/index.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures');
const CLI = path.join(here, '..', 'dist', 'cli.js');

test('checkPackage finds a top-level await through the built dist', async () => {
  const report = await checkPackage(path.join(FIXTURES, 'tla-via-import'));
  const entry = report.entries.find((e) => e.specifier === '.');
  assert.equal(entry.status, 'top-level-await');
  assert.equal(entry.requirable, false);
  assert.equal(entry.awaits.length, 1);
});

test('checkPackage reports a clean package as ok', async () => {
  const report = await checkPackage(path.join(FIXTURES, 'ok-esm-no-tla'));
  assert.equal(report.clean, true);
});

test('CLI exits 1 on a finding and 0 on a clean package', () => {
  assert.throws(() => execFileSync(process.execPath, [CLI, path.join(FIXTURES, 'direct-tla')]), (err) => {
    assert.equal(err.status, 1);
    return true;
  });
  const out = execFileSync(process.execPath, [CLI, path.join(FIXTURES, 'ok-esm-no-tla')], { encoding: 'utf8' });
  assert.match(out, /ok/);
});

test('CLI --json prints parseable JSON', () => {
  const out = execFileSync(process.execPath, [CLI, '--json', path.join(FIXTURES, 'ok-esm-no-tla')], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.clean, true);
});
