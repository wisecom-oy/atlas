import type { DriveFolderColorRestoreSummary } from '@wisecom/atlas-types';
import type { DriveManifestEntry } from '@/drive-ports';
import { present_folder_color } from '@/shared/folder-color';

/**
 * The folder colours a restore leaves out, as result fields. Graph refuses every write to the
 * colour columns (`403 accessDenied: Field '_ColorHex' is read-only`), so no write is attempted and
 * restored folders take the destination's default colour. Counted, never an error, so the run's
 * exit code does not change. Set only when non-zero, so a restore without colours reads as before.
 */
export function folder_colors_not_restored(
  folder_entries: readonly DriveManifestEntry[],
): DriveFolderColorRestoreSummary {
  const count = folder_entries.filter(
    (entry) => present_folder_color(entry.folder_color) !== undefined,
  ).length;
  return count > 0 ? { folder_colors_not_restored: count } : {};
}
