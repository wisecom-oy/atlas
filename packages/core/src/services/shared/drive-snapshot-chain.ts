/**
 * Folds a chain of drive delta manifests into one point-in-time view.
 *
 * OneDrive and SharePoint back up incrementally: a snapshot manifest lists only the items that
 * changed in that run. Restoring, exporting or verifying a single manifest therefore covers only
 * the last delta and silently ignores everything carried over from earlier runs (issue #173).
 * Outlook has always folded its chain; these helpers give the drive workloads the same semantics.
 */

/** The shape both drive manifests share: entries keyed by drive item id. */
export interface DriveChainManifest<Entry> {
  readonly snapshot_id: string;
  readonly entries: readonly Entry[];
}

/** One folded entry, tagged with the snapshot that actually recorded it. */
export interface DriveChainEntry<Entry> {
  readonly snapshot_id: string;
  readonly entry: Entry;
}

/**
 * Reduces a newest-first chain to the newest state of every file.
 *
 * A file keeps the first entry seen, which is its newest version. Tombstones are entries like any
 * other: a file whose newest entry is a deletion stays in the result carrying `change_type:
 * 'deleted'`, so the existing restore and export filters skip it instead of resurrecting a file the
 * user removed. Callers that need only the entries map over `.entry`.
 */
export function fold_drive_snapshot_chain<Entry extends { readonly file_id: string }>(
  manifests: readonly DriveChainManifest<Entry>[],
): DriveChainEntry<Entry>[] {
  const seen = new Set<string>();
  const folded: DriveChainEntry<Entry>[] = [];

  for (const manifest of manifests) {
    for (const entry of manifest.entries) {
      if (seen.has(entry.file_id)) continue;
      seen.add(entry.file_id);
      folded.push({ snapshot_id: manifest.snapshot_id, entry });
    }
  }

  return folded;
}

/**
 * Selects the target manifest and every older one for the same scope, newest-first.
 *
 * `created_at` ties are broken by keeping the target first, so a chain never depends on the order
 * the storage listing happened to return.
 */
export function select_drive_manifest_chain<
  Manifest extends { readonly snapshot_id: string; readonly created_at: Date },
>(all: readonly Manifest[], target: Manifest): Manifest[] {
  const cutoff = target.created_at.getTime();
  const older = all.filter(
    (candidate) =>
      candidate.snapshot_id !== target.snapshot_id && candidate.created_at.getTime() <= cutoff,
  );
  older.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  return [target, ...older];
}
