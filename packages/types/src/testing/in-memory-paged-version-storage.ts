import type {
  ObjectStorage,
  StorageDeleteOutcome,
  StorageDeleteTarget,
  StorageObjectVersion,
} from '@/index';
import type { InMemoryVersionedStorage } from '@/testing/in-memory-versioned-storage';

/** A versioned in-memory bucket that pages its version listing and can delete in batches. */
export interface InMemoryPagedVersionStorage extends InMemoryVersionedStorage {
  /** Every `delete_batch` call, with the targets it carried, in call order. */
  readonly batch_calls: readonly (readonly StorageDeleteTarget[])[];
  /** How many listing pages were handed out. */
  readonly pages_listed: () => number;
  /** The most entries handed out by the listing and not yet deleted or refused at any moment. */
  readonly peak_unsettled_entries: () => number;
}

export interface InMemoryPagedVersionStorageOptions {
  /** Entries per listing page. */
  readonly page_size: number;
  /**
   * Tells a retention refusal from any other, for `delete_batch` outcomes. The test supplies it
   * for the same reason.
   */
  readonly is_retention_refusal: (err: unknown) => boolean;
  /** Leave `delete_batch` off, as an adapter without a bulk delete would. */
  readonly without_delete_batch?: boolean;
}

/**
 * Wraps `bucket` with a `list_version_pages` that follows a key and version marker, as S3 does, so
 * versions deleted while the walk runs never shift a later page. `delete_batch` maps a retention
 * refusal to `retained` and any other refusal to `failed`. The bucket comes from
 * `in_memory_versioned_storage` and is passed in, because these helpers are loaded from source and
 * cannot import one another at run time.
 */
export function in_memory_paged_version_storage(
  bucket: InMemoryVersionedStorage,
  options: InMemoryPagedVersionStorageOptions,
): InMemoryPagedVersionStorage {
  const inner = bucket.storage;
  const batch_calls: StorageDeleteTarget[][] = [];
  const counters = { pages: 0, unsettled: 0, peak: 0 };

  const settle = (count: number): void => {
    counters.unsettled -= count;
  };
  const delete_one = async (target: StorageDeleteTarget): Promise<void> => {
    try {
      if (target.version_id === undefined) await inner.delete(target.key);
      else await inner.delete_version(target.key, target.version_id);
    } finally {
      settle(1);
    }
  };

  async function* list_version_pages(prefix: string): AsyncGenerator<StorageObjectVersion[]> {
    let marker: StorageObjectVersion | undefined;
    do {
      const remaining = sorted(await inner.list_versions(prefix)).filter(
        (version) => marker === undefined || compare(version, marker) > 0,
      );
      const page = remaining.slice(0, options.page_size);
      if (page.length === 0) return;
      counters.pages++;
      counters.unsettled += page.length;
      counters.peak = Math.max(counters.peak, counters.unsettled);
      marker = page.at(-1);
      yield page;
      if (remaining.length <= options.page_size) return;
    } while (true);
  }

  async function delete_batch(
    targets: readonly StorageDeleteTarget[],
  ): Promise<StorageDeleteOutcome[]> {
    batch_calls.push([...targets]);
    const outcomes: StorageDeleteOutcome[] = [];
    for (const target of targets) {
      try {
        await delete_one(target);
        outcomes.push('deleted');
      } catch (err) {
        outcomes.push(options.is_retention_refusal(err) ? 'retained' : 'failed');
      }
    }
    return outcomes;
  }

  const storage = Object.assign(Object.create(null) as object, inner, {
    list_version_pages,
    delete: (key: string) => delete_one({ key }),
    delete_version: (key: string, version_id: string) => delete_one({ key, version_id }),
    ...(options.without_delete_batch ? {} : { delete_batch }),
  }) as ObjectStorage;

  return {
    ...bucket,
    storage,
    batch_calls,
    pages_listed: () => counters.pages,
    peak_unsettled_entries: () => counters.peak,
  };
}

function sorted(versions: readonly StorageObjectVersion[]): StorageObjectVersion[] {
  return [...versions].sort(compare);
}

/** Orders by key, then by the sequence number the in-memory bucket puts in each version id. */
function compare(a: StorageObjectVersion, b: StorageObjectVersion): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return sequence_of(a.version_id) - sequence_of(b.version_id);
}

function sequence_of(version_id: string): number {
  return Number(version_id.slice(1));
}
