import type { SnapshotPruneResult } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core';
import { format_bytes } from '@/command-formatters';

const SKIP_REASONS: Record<NonNullable<SnapshotPruneResult['content_sweep_skipped']>, string> = {
  unreadable_objects:
    'Unreferenced content was not removed: a manifest or version index of this owner could not ' +
    'be read, so what it references is unknown.',
  quarantined_objects:
    'Unreferenced content was not removed: this owner has quarantined manifests or version ' +
    'indexes, whose references are unknown. Delete them from _quarantine/ once they are not needed.',
  interrupted: 'The run was interrupted. Run the same command again to finish.',
};

/**
 * Prints what a prune removed, or what a dry run would remove. A run that left anything behind
 * (a retained or failed object, or content it could not sweep) fails with exit code 1, as a
 * delete does, so a scheduled job notices; repeating the run later finishes it.
 */
export function print_prune_result(result: SnapshotPruneResult): void {
  const verb = result.dry_run ? 'Would remove' : 'Removed';
  logger.info(`Cut-off: ${result.before.toISOString()}`);
  if (result.baseline_snapshot_ids.length > 0) {
    logger.info(`Oldest kept snapshot, now a baseline: ${result.baseline_snapshot_ids.join(', ')}`);
  }
  logger.success(
    `${verb} ${result.removed_snapshot_ids.length} snapshot(s): ${result.deleted_manifests} ` +
      `manifest version(s), ${result.deleted_objects} other object version(s), ` +
      `${format_bytes(result.deleted_bytes)}`,
  );
  report_survivors(result);
  if (result.content_sweep_skipped !== undefined) {
    logger.warn(SKIP_REASONS[result.content_sweep_skipped]);
  }
  if (!result.dry_run && left_anything_behind(result)) process.exitCode = 1;
}

function report_survivors(result: SnapshotPruneResult): void {
  for (const key of result.retained_manifest_keys) {
    logger.warn(`Retained by Object Lock, removed by a later run: ${key}`);
  }
  for (const key of result.failed_manifest_keys) logger.error(`Could not delete: ${key}`);
  if (result.retained_objects > 0 || result.failed_objects > 0) {
    logger.info(
      `Not deleted: ${result.retained_objects} object version(s) retained by Object Lock, ` +
        `${result.failed_objects} failed for other reasons`,
    );
  }
}

function left_anything_behind(result: SnapshotPruneResult): boolean {
  return (
    result.retained_manifests + result.retained_objects > 0 ||
    result.failed_manifests + result.failed_objects > 0 ||
    result.content_sweep_skipped !== undefined
  );
}
