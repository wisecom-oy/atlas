import { logger } from '@wisecom/atlas-core';

/**
 * Exit code for a run that produced a snapshot but is incomplete (per-item
 * errors or an interrupt). Distinct from 1 (hard failure) so schedulers can
 * separate "page me" from "warn me". Corso's fault model: a backup is
 * complete only when every error bucket is empty.
 */
export const EXIT_PARTIAL = 2;

export interface RunOutcome {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly interrupted?: boolean;
  /**
   * Items that decrypted cleanly but did not match the checksum their manifest
   * records. A separate bucket because the item is still written, so the run
   * reports no error and used to exit 0, while the output is no longer known to
   * be the content that was backed up.
   */
  readonly integrity_failures?: readonly string[];
}

/**
 * Prints per-item errors/warnings on stderr and sets the partial exit code
 * when the run is incomplete. Shared by Outlook, OneDrive, and SharePoint
 * backup, save, and restore commands so all three domains report identically.
 * Hard failures throw and exit 1 upstream; this only handles the partial bucket.
 */
export function report_run_outcome(outcome: RunOutcome, item_noun: string): void {
  for (const warning of outcome.warnings) {
    logger.warn(`  ${warning}`);
  }
  for (const error of outcome.errors) {
    logger.error(`  ${item_noun} error: ${error}`);
  }

  const integrity_failures = outcome.integrity_failures ?? [];
  for (const failure of integrity_failures) {
    logger.error(`  ${item_noun} integrity failure: ${failure}`);
  }

  if (outcome.interrupted) {
    logger.warn('Run interrupted before all items were processed');
  }

  const incomplete =
    outcome.errors.length > 0 || integrity_failures.length > 0 || outcome.interrupted === true;
  if (!incomplete) return;

  const suffix = outcome.interrupted === true ? ' (interrupted)' : '';
  const counts = [
    `${outcome.errors.length} ${item_noun} error(s)`,
    ...(integrity_failures.length > 0 ? [`${integrity_failures.length} integrity failure(s)`] : []),
  ].join(', ');
  logger.error(`Run incomplete: ${counts}${suffix} -- exit ${EXIT_PARTIAL}`);
  process.exitCode = EXIT_PARTIAL;
}

/**
 * Reports items a restore or export dropped, and exits partial.
 *
 * Restore and save count a failed item as `files_skipped` rather than an error,
 * so before this the command printed a warning and exited `0`. That is how #143
 * hid: streaming decrypt aborted on every file over 4 MB, `save` wrote an empty
 * archive, and both the operator's cron job and the nightly E2E run saw success.
 */
export function report_skipped_items(skipped: number, item_noun: string): void {
  if (skipped <= 0) return;
  logger.error(`${item_noun}s skipped: ${skipped} -- exit ${EXIT_PARTIAL}`);
  process.exitCode = EXIT_PARTIAL;
}
