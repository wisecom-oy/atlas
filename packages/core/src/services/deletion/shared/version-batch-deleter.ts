/**
 * Deletes a stream of object versions in batches, a bounded number of batches at a time.
 *
 * This is the erasure engine behind `delete_scopes`, and it takes any iterable of entries, not
 * only a prefix listing, so a caller that computes the versions to remove can reuse it. Memory is
 * bounded by the batch size and the concurrency, never by how many entries the stream yields: the
 * stream is pulled only when a batch slot is free.
 */

import { ObjectLockRetainedError } from '@wisecom/atlas-types';
import type {
  DeletionResult,
  ObjectStorage,
  StorageDeleteOutcome,
  StorageDeleteTarget,
} from '@wisecom/atlas-types';
import {
  empty_tally,
  tally_outcome,
  type DeletionTally,
} from '@/services/deletion/shared/deletion-tally';
import { logger } from '@/utils/logger';

/** Entries per delete request: the S3 `DeleteObjects` limit. */
export const DELETE_BATCH_SIZE = 1000;

/**
 * Delete requests in flight at once. A sweep holds these batches, the one being filled, and one
 * listing page: about 6,000 entries at most, whatever the bucket holds.
 */
export const CONCURRENT_DELETE_BATCHES = 4;

/** The storage calls the batched deleter uses. */
export interface BatchDeletionStorage {
  delete(key: string): Promise<void>;
  delete_version(key: string, version_id: string): Promise<void>;
  readonly delete_batch?: ObjectStorage['delete_batch'];
}

/** One entry to delete: a version when `version_id` is set, otherwise the visible key. */
export interface DeletableEntry extends StorageDeleteTarget {
  readonly is_delete_marker?: boolean | undefined;
}

/**
 * Deletes every entry the stream yields and counts each outcome as deleted, retained or failed.
 * A refused or failed delete is counted, never thrown; an error from the stream itself propagates
 * once the batches already sent have settled.
 */
export async function delete_entries_in_batches(
  storage: BatchDeletionStorage,
  entries: AsyncIterable<DeletableEntry> | Iterable<DeletableEntry>,
): Promise<DeletionResult> {
  const tally = empty_tally();
  const in_flight = new Set<Promise<void>>();
  try {
    for await (const batch of batches_of(entries, DELETE_BATCH_SIZE)) {
      const task: Promise<void> = delete_and_tally_batch(storage, batch, tally).finally(() =>
        in_flight.delete(task),
      );
      in_flight.add(task);
      if (in_flight.size >= CONCURRENT_DELETE_BATCHES) await Promise.race(in_flight);
    }
  } finally {
    await Promise.all(in_flight);
  }
  return { ...tally };
}

/** Groups a stream into arrays of at most `size` entries, pulling only as far as it yields. */
export async function* batches_of<T>(
  entries: AsyncIterable<T> | Iterable<T>,
  size: number,
): AsyncGenerator<T[]> {
  let batch: T[] = [];
  for await (const entry of entries) {
    batch.push(entry);
    if (batch.length < size) continue;
    yield batch;
    batch = [];
  }
  if (batch.length > 0) yield batch;
}

async function delete_and_tally_batch(
  storage: BatchDeletionStorage,
  batch: readonly DeletableEntry[],
  tally: DeletionTally,
): Promise<void> {
  const outcomes = await delete_batch_outcomes(storage, batch);
  batch.forEach((entry, index) => tally_outcome(tally, entry, outcomes[index] ?? 'failed'));
}

/** Sends one batch as a single request where the storage can, otherwise one delete per entry. */
async function delete_batch_outcomes(
  storage: BatchDeletionStorage,
  batch: readonly DeletableEntry[],
): Promise<readonly StorageDeleteOutcome[]> {
  if (!storage.delete_batch) return delete_one_by_one(storage, batch);
  try {
    return await storage.delete_batch(batch);
  } catch (err) {
    // The request itself failed after the client's retries, so no entry in it can be vouched for.
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(`A batch delete of ${batch.length} entries failed: ${reason}`);
    return batch.map(() => 'failed');
  }
}

async function delete_one_by_one(
  storage: BatchDeletionStorage,
  batch: readonly DeletableEntry[],
): Promise<StorageDeleteOutcome[]> {
  const outcomes: StorageDeleteOutcome[] = [];
  for (const entry of batch) outcomes.push(await delete_single_entry(storage, entry));
  return outcomes;
}

async function delete_single_entry(
  storage: BatchDeletionStorage,
  entry: DeletableEntry,
): Promise<StorageDeleteOutcome> {
  try {
    if (entry.version_id === undefined) await storage.delete(entry.key);
    else await storage.delete_version(entry.key, entry.version_id);
    return 'deleted';
  } catch (err) {
    // The storage adapter names a retention refusal for us: a bare `AccessDenied` from a missing
    // IAM permission must not be filed as "retained, deletable once retention expires", because
    // on an erasure report a false all-clear costs the erasure (issue #40).
    return err instanceof ObjectLockRetainedError ? 'retained' : 'failed';
  }
}
