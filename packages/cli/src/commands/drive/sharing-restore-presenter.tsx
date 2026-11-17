import { logger } from '@wisecom/atlas-core';
import type { DriveSharingRestoreSummary } from '@wisecom/atlas-types';
import type { KeyValueItem } from '@/ui/components/key-value-list';

/** How many skipped permissions are listed one by one before the rest is summed up. */
const SKIPPED_LISTED = 50;

/** Summary rows for permissions, present only when the restore met any. */
export function sharing_restore_items(summary: DriveSharingRestoreSummary): KeyValueItem[] {
  const items: KeyValueItem[] = [];
  const requested = (summary.permissions_applied ?? 0) + (summary.permissions_skipped ?? 0);
  if (requested > 0) {
    items.push({
      label: 'Permissions reapplied',
      value: `${summary.permissions_applied ?? 0} of ${requested}`,
    });
  }
  if ((summary.permissions_not_requested ?? 0) > 0) {
    items.push({
      label: 'Permissions not restored',
      value: `${summary.permissions_not_requested} (pass --restore-permissions to reapply)`,
    });
  }
  return items;
}

/**
 * Lists each permission the restore left out, with the reason. These are expected
 * outcomes (a deleted grantee, a policy that forbids anonymous links), so they are warnings and do
 * not change the exit code.
 */
export function report_sharing_skips(summary: DriveSharingRestoreSummary): void {
  const skipped = summary.skipped_items ?? [];
  for (const item of skipped.slice(0, SKIPPED_LISTED)) {
    const what = item.detail ? `${item.kind} ${item.detail}` : item.kind;
    logger.warn(`Not restored: ${item.path}: ${what}: ${item.reason}`);
  }
  if (skipped.length > SKIPPED_LISTED) {
    logger.warn(`...and ${skipped.length - SKIPPED_LISTED} more permission(s)`);
  }
}
