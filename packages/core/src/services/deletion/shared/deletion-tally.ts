import type { DeletionResult, StorageDeleteOutcome } from '@wisecom/atlas-types';

/** A deletion summary being counted up while a sweep runs. */
export type DeletionTally = { -readonly [K in keyof DeletionResult]: number };

/** What the tally needs to know about one deleted entry. */
export interface TalliedEntry {
  readonly key: string;
  readonly is_delete_marker?: boolean | undefined;
}

/** A tally with every count at zero. */
export function empty_tally(): DeletionTally {
  return {
    deleted_objects: 0,
    deleted_manifests: 0,
    retained_objects: 0,
    retained_manifests: 0,
    failed_objects: 0,
    failed_manifests: 0,
  };
}

/** True for manifest keys at any depth: `manifests/…` and `onedrive/manifests/…`. */
export function is_manifest_key(key: string): boolean {
  return key.split('/').includes('manifests');
}

/** Counts one entry's outcome as a manifest or an object. */
export function tally_outcome(
  tally: DeletionTally,
  entry: TalliedEntry,
  outcome: StorageDeleteOutcome,
): void {
  // Removing a delete marker uncovers the versions beneath it rather than
  // erasing anything, so a successful sweep of one is not counted as data. A
  // marker we could not remove still counts: it is an entry that outlived the
  // sweep, and a purge must not read the summary as clean and drop the DEK.
  if (outcome === 'deleted' && entry.is_delete_marker === true) return;

  const kind = is_manifest_key(entry.key) ? 'manifests' : 'objects';
  tally[`${outcome}_${kind}`]++;
}
