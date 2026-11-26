import { classify_download_failure } from '@wisecom/atlas-m365-graph';
import { is_run_fatal_error } from '@wisecom/atlas-core/services/shared/run-fatal-error';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { DriveWorkload } from '@/drive-ports';
import { DRIVE_WORKLOAD_LABEL } from '@/backup/drive-workload-label';
import { type DenialBinding, missing_permissions_error } from '@/backup/enumeration-access-denial';

/**
 * Refusals that apply to every write of a OneDrive or SharePoint restore, so they end it instead of
 * failing one file at a time (issue #871).
 *
 * An `AuthError` already means the credential or a grant was refused. A raw Graph `403` on a
 * restore write counts only when its code names a missing grant (`accessDenied`), the same rule
 * the backup applies since #957. Any other `403`, such as one item refused on its own, still fails
 * only that file.
 */

/** The write permissions a restore needs, named in the missing-grant error. */
const RESTORE_WRITE_GRANT: Readonly<Record<DriveWorkload, DenialBinding>> = {
  onedrive: { workload: 'onedrive', read_permissions: ['Files.ReadWrite.All'] },
  sharepoint: {
    workload: 'sharepoint',
    read_permissions: ['Sites.ReadWrite.All'],
    grant_alternative: 'a Sites.Selected grant with the write role on this site',
  },
};

/** True for a failure that refuses every write of the restore, not just this file's. */
export function is_restore_run_refusal(err: unknown): boolean {
  if (is_run_fatal_error(err)) return true;
  return classify_download_failure(err) === 'missing_permission';
}

/**
 * Rethrows a restore run refusal as the typed error that ends the run: an `AuthError` unchanged,
 * and a raw missing-grant `403` as `MissingGraphPermissionsError` naming the write permissions to
 * grant. Returns for anything else, which fails only its own file.
 */
export function rethrow_if_restore_run_refusal(workload: DriveWorkload, err: unknown): void {
  if (is_run_fatal_error(err)) throw err;
  if (classify_download_failure(err) !== 'missing_permission') return;
  throw missing_permissions_error(RESTORE_WRITE_GRANT[workload], err, 'for a restore write');
}

/**
 * Logs how many files were restored before a run refusal stopped the restore, then rethrows it.
 * The files before it are in the target and were each logged as restored.
 */
export function stop_restore_on_refusal(
  workload: DriveWorkload,
  files_restored: number,
  err: unknown,
): never {
  logger.warn(
    `${DRIVE_WORKLOAD_LABEL[workload]} restore stopped after ${files_restored} file(s) restored: ` +
      'Microsoft Graph refused the restore for the whole target.',
  );
  throw err;
}
