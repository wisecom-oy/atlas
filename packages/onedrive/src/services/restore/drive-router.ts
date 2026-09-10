import type { OneDriveManifestEntry } from '@wisecom/atlas-types';

export interface RoutedDrive {
  /** Where this entry is restored. Meaningless when `error` is set. */
  readonly drive_id: string;
  /** Set when the entry cannot be placed; it is skipped rather than written somewhere else. */
  readonly error?: string;
}

/**
 * Decides which of the target owner's drives each manifest entry belongs in.
 *
 * A same-owner restore uses the drive the entry records, because an owner can have several and
 * the first one Graph lists is a guess. A cross-owner restore has no mapping to work from, since
 * Atlas records drive ids and not drive names, so it is allowed only when the snapshot came from
 * a single drive and is refused otherwise (issue #361).
 *
 * @throws Error when a cross-owner restore spans more than one source drive.
 */
export function build_drive_router(
  entries: readonly OneDriveManifestEntry[],
  target_drive_ids: readonly string[],
  owner_id: string,
  target_owner: string,
): (entry: OneDriveManifestEntry) => RoutedDrive {
  const cross_owner = target_owner !== owner_id;
  const source_drive_ids = new Set(entries.map((entry) => entry.drive_id));

  if (cross_owner && source_drive_ids.size > 1) {
    throw new Error(
      `This snapshot spans ${source_drive_ids.size} drives and Atlas records no drive names, so ` +
        `there is no way to tell which of ${target_owner}'s drives each file belongs in. ` +
        `Restore to the original owner, or restore one drive at a time with --file-filter.`,
    );
  }

  const [primary_drive_id] = target_drive_ids;
  const known = new Set(target_drive_ids);

  return (entry) => {
    if (cross_owner) return { drive_id: primary_drive_id ?? '' };
    if (known.has(entry.drive_id)) return { drive_id: entry.drive_id };
    return {
      drive_id: entry.drive_id,
      error:
        `${entry.file_name}: recorded drive ${entry.drive_id} no longer exists for ` +
        `${target_owner}; not restored into another drive`,
    };
  };
}
