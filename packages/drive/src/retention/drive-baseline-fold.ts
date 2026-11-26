import type { DriveEntryKind } from '@wisecom/atlas-types';
import type {
  BaselineFold,
  PrunableManifest,
} from '@wisecom/atlas-core/services/retention/snapshot-prune-target';
import { count_file_entries } from '@/shared/entry-kind';

/** What the fold reads from a drive manifest entry of either provider. */
export interface FoldableDriveEntry {
  readonly file_id: string;
  readonly change_type: string;
  readonly kind?: Exclude<DriveEntryKind, 'file'> | undefined;
  readonly size_bytes: number;
}

/** What the fold reads from and writes to a drive manifest of either provider. */
export interface FoldableDriveManifest<E extends FoldableDriveEntry> extends PrunableManifest {
  readonly entries: E[];
  readonly total_files: number;
  readonly total_size_bytes: number;
}

/**
 * Folds a drive baseline's chain one manifest at a time, newest first, into the snapshot its
 * restore saw: `fold_drive_snapshot_chain`, written as one manifest under the baseline's id.
 *
 * The baseline's own entries are kept as they are, tombstones included. A tombstone carried from
 * an older manifest is kept only when an even older one holds a live entry for the same file: it
 * then shadows that entry in any older manifest Object Lock keeps past the prune. One that shadows
 * nothing is dropped, so the name of a file deleted long ago is not carried forward for ever.
 */
export class DriveBaselineFold<
  E extends FoldableDriveEntry,
  M extends FoldableDriveManifest<E>,
> implements BaselineFold<M> {
  private readonly _entries: E[] = [];
  private readonly _seen = new Set<string>();
  private readonly _unneeded_tombstones = new Set<string>();
  private _target: M | undefined;

  /** Adds the next manifest of the chain: the baseline first, then each older one. */
  add(manifest: M): void {
    const is_target = this._target === undefined;
    this._target ??= manifest;
    for (const entry of manifest.entries) this.add_entry(entry, is_target);
  }

  /** The folded baseline, with its totals recomputed from its entries. */
  result(): M {
    const target = this._target;
    if (target === undefined) throw new Error('A drive baseline fold needs the baseline first');
    const entries = this._entries.filter((entry) => !this._unneeded_tombstones.has(entry.file_id));
    return {
      ...target,
      total_files: count_file_entries(entries),
      total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
      entries,
    };
  }

  private add_entry(entry: E, is_target: boolean): void {
    const is_tombstone = entry.change_type === 'deleted';
    if (!this._seen.has(entry.file_id)) {
      this._seen.add(entry.file_id);
      this._entries.push(entry);
      if (!is_target && is_tombstone) this._unneeded_tombstones.add(entry.file_id);
      return;
    }
    if (!is_tombstone) this._unneeded_tombstones.delete(entry.file_id);
  }
}

/** Whether the stored baseline already holds what the fold produced, so no write is needed. */
export function drive_baseline_matches<
  E extends FoldableDriveEntry,
  M extends FoldableDriveManifest<E>,
>(stored: M, folded: M): boolean {
  const comparable = (manifest: M): unknown => [
    manifest.entries,
    manifest.total_files,
    manifest.total_size_bytes,
  ];
  return JSON.stringify(comparable(stored)) === JSON.stringify(comparable(folded));
}
