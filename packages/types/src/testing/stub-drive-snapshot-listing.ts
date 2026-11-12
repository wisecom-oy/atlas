/** The snapshot `list_one_drive_snapshot` reports unless told otherwise. */
export const LISTED_DRIVE_SNAPSHOT_ID = 'snap-0';

/**
 * A `storage.list` for a OneDrive owner or SharePoint site that has one snapshot: the manifest
 * prefix answers with that snapshot's key, every other prefix with nothing.
 *
 * A drive delta cursor is resumed only while the snapshot it was saved with still has a manifest,
 * and a cursor that records no snapshot only while any manifest exists (issue #725). A test that
 * hands a backup or status service a saved cursor therefore has to say a snapshot is stored.
 */
export function list_one_drive_snapshot(
  snapshot_id: string = LISTED_DRIVE_SNAPSHOT_ID,
): (prefix: string) => Promise<string[]> {
  return (prefix) =>
    Promise.resolve(
      /^(onedrive|sharepoint)\/manifests\/[^/]+\/$/.test(prefix)
        ? [`${prefix}${snapshot_id}.json`]
        : [],
    );
}
