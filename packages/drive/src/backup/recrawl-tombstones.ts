import { fold_drive_snapshot_chain } from '@wisecom/atlas-core/services/shared/drive-snapshot-chain';

/** What a tombstone needs from a manifest entry; both providers' entries carry it. */
interface TrackedEntry {
  readonly file_id: string;
  readonly drive_id: string;
  readonly storage_key?: string | undefined;
  readonly checksum?: string | undefined;
  readonly change_type: string;
  readonly backup_at: string;
}

interface ChainManifest<Entry> {
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly entries: readonly Entry[];
}

/** One drive whose full enumeration finished, with every item id it returned. */
export interface DriveRecrawl {
  readonly drive_id: string;
  readonly returned_item_ids: ReadonlySet<string>;
}

/**
 * The drive's finished full enumeration: every item id it returned. Undefined for an incremental
 * delta, which already reports deletions, and for an interrupted one, whose absences prove nothing.
 */
export function completed_recrawl(
  drive_id: string,
  delta: {
    readonly items: readonly { readonly item_id: string }[];
    readonly reset_detected: boolean;
  },
  prev_delta_link: string | undefined,
  interrupted: boolean,
): DriveRecrawl | undefined {
  if (interrupted || (prev_delta_link !== undefined && !delta.reset_detected)) return undefined;
  return { drive_id, returned_item_ids: new Set(delta.items.map((item) => item.item_id)) };
}

/** The slice of a scan result the tombstones are folded into. */
export interface RecrawlScan<Entry extends TrackedEntry> {
  readonly entries: Entry[];
  deleted_items: number;
  readonly recrawls: readonly DriveRecrawl[];
}

/**
 * Appends a tombstone to `scan.entries` for each file a completed full enumeration no longer lists,
 * and counts it in `scan.deleted_items`.
 *
 * A full enumeration (`--full`, a changed `--folder` scope, or a delta reset) lists what exists,
 * not what was removed since the last run, so a file deleted in between got no tombstone and its
 * older entry kept winning the chain fold: restore, save and verify brought it back (issue #435).
 * Graph documents the same duty for a resync: compare the enumeration with local state.
 *
 * Only drives in `recrawls` are compared, so one drive's re-crawl never tombstones another's
 * files (#199). The scan lists a drive there only when its enumeration and processing finished,
 * because absence proves nothing when the listing stopped early. `is_in_scope` narrows the
 * comparison to a `--folder` scope. No manifest is read when nothing was re-crawled.
 */
export async function append_recrawl_tombstones<Entry extends TrackedEntry>(
  scan: RecrawlScan<Entry>,
  list_previous_manifests: () => Promise<readonly ChainManifest<Entry>[]>,
  is_in_scope: (entry: Entry) => boolean = () => true,
): Promise<void> {
  if (scan.recrawls.length === 0) return;
  const previous = fold_newest_entries(await list_previous_manifests());
  const returned_by_drive = new Map(scan.recrawls.map((r) => [r.drive_id, r.returned_item_ids]));
  const written = new Set(scan.entries.map((entry) => entry.file_id));
  const backup_at = new Date().toISOString();

  const tombstones = previous
    .filter((entry) => {
      const returned = returned_by_drive.get(entry.drive_id);
      return (
        returned !== undefined &&
        entry.change_type !== 'deleted' &&
        !returned.has(entry.file_id) &&
        !written.has(entry.file_id) &&
        is_in_scope(entry)
      );
    })
    .map((entry) => to_tombstone(entry, backup_at));
  scan.entries.push(...tombstones);
  scan.deleted_items += tombstones.length;
}

/** Folds every earlier manifest newest-first into the latest state of each file. */
function fold_newest_entries<Entry extends TrackedEntry>(
  manifests: readonly ChainManifest<Entry>[],
): Entry[] {
  const newest_first = [...manifests].sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
  return fold_drive_snapshot_chain(newest_first).map(({ entry }) => entry);
}

/** Keeps the file's identity and path for display, drops the blob it no longer has. */
function to_tombstone<Entry extends TrackedEntry>(entry: Entry, backup_at: string): Entry {
  const { storage_key: _storage_key, checksum: _checksum, ...identity } = entry;
  // The spread loses the link to `Entry` for the compiler only: `storage_key` and `checksum` are
  // optional on every entry type, and 'deleted' is a member of both providers' change types.
  return { ...identity, change_type: 'deleted', backup_at } as unknown as Entry;
}
