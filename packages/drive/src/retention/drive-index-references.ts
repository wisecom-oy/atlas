import { UnreadableContentError } from '@wisecom/atlas-types';
import type { ReferencedKeySet } from '@wisecom/atlas-core/services/retention/referenced-key-set';
import type { ReferenceScanOutcome } from '@wisecom/atlas-core/services/retention/snapshot-prune-target';
import type { DriveFileVersionIndexView } from '@/drive-ports';

/** What the reference scan needs to read an owner's version indexes. */
export interface IndexReferenceSource {
  readonly ctx: { readonly storage: { list(prefix: string): Promise<string[]> } };
  readonly read_index_object: (key: string) => Promise<DriveFileVersionIndexView[] | undefined>;
}

/**
 * Records the blob of every version row in the owner's index objects, per-run and legacy per-file
 * alike, one object at a time. `excluded_keys` are run indexes the prune removed. Reports
 * `unreadable` when any object fails to read: its rows may name blobs nothing else does.
 */
export async function add_index_references(
  source: IndexReferenceSource,
  index_prefix: string,
  references: ReferencedKeySet,
  excluded_keys: ReadonlySet<string>,
): Promise<ReferenceScanOutcome> {
  for (const key of await source.ctx.storage.list(index_prefix)) {
    if (excluded_keys.has(key)) continue;
    let indexes: DriveFileVersionIndexView[] | undefined;
    try {
      indexes = await source.read_index_object(key);
    } catch (err) {
      if (err instanceof UnreadableContentError) return 'unreadable';
      throw err;
    }
    for (const index of indexes ?? []) {
      for (const row of index.versions) references.add(row.storage_key);
    }
  }
  return 'complete';
}
