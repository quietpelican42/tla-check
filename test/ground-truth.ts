import { spawnSync } from 'node:child_process';

export interface GroundTruth {
  /** true: require() succeeded. false: it threw ERR_REQUIRE_ASYNC_MODULE. */
  requirable?: boolean;
  /** Set when require() threw something other than ERR_REQUIRE_ASYNC_MODULE (e.g. MODULE_NOT_FOUND). */
  otherErrorCode?: string;
}

/**
 * Ground truth: actually `require()` a file in a real, separate Node child
 * process and report what really happened. This is what fixture assertions
 * are checked against — never a guess about Node's behaviour.
 */
export function realRequireVerdict(absoluteFile: string): GroundTruth {
  const result = spawnSync(
    process.execPath,
    ['-e', 'try { require(process.argv[1]); console.log("OK"); } catch (e) { console.log("ERR:" + e.code); }', absoluteFile],
    { encoding: 'utf8' },
  );
  const out = (result.stdout || '').trim();
  if (out === 'OK') return { requirable: true };
  if (out === 'ERR:ERR_REQUIRE_ASYNC_MODULE') return { requirable: false };
  if (out.startsWith('ERR:')) return { otherErrorCode: out.slice(4) || result.stderr.slice(0, 200) };
  return { otherErrorCode: `no verdict; stderr: ${result.stderr.slice(0, 300)}` };
}
