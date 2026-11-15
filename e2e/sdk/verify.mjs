/**
 * Deep and fast verification of each snapshot in E2E_SNAPSHOT_IDS (comma separated).
 *
 * Deep mode downloads, decrypts and hashes every object; fast mode only checks that each exists.
 * Prints per snapshot the counters of both modes and the phases their progress went through.
 */

import { create_instance, main, progress_recorder, required_env } from './lib.mjs';

/** One verification run, reduced to counts and phases. */
async function verify_once(atlas, snapshot, fast) {
  const progress = progress_recorder();
  const report = await atlas.outlook.verify(snapshot, { fast, onProgress: progress.on_progress });
  return {
    snapshot_id: report.snapshotId,
    total_checked: report.totalChecked,
    passed: report.passed,
    failed: report.failed.length,
    unverifiable: report.unverifiable.length,
    manifests_in_chain: report.manifestsInChain,
    interrupted: report.interrupted,
    events: progress.events,
  };
}

await main(async () => {
  const snapshots = required_env('E2E_SNAPSHOT_IDS').split(',');
  const atlas = create_instance();
  try {
    const results = [];
    for (const snapshot of snapshots) {
      results.push({
        deep: await verify_once(atlas, snapshot, false),
        fast: await verify_once(atlas, snapshot, true),
      });
    }
    return { results };
  } finally {
    await atlas.dispose();
  }
});
