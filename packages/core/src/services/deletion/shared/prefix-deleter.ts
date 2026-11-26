/**
 * The single deletion primitive behind Outlook, OneDrive and SharePoint erasure.
 *
 * Deleting a key without a version id is not erasure. In a versioned bucket --
 * the prerequisite for Object Lock, so every immutability deployment has one --
 * `DeleteObject` writes a delete marker and leaves the bytes retrievable as a
 * noncurrent version. Everything here therefore deletes by version id, and falls
 * back to plain keys only for backends that do not enumerate versions.
 */

import { NotFoundError } from '@wisecom/atlas-types';
import type { DeletionResult, ObjectStorage, StorageObjectVersion } from '@wisecom/atlas-types';
import { empty_tally } from '@/services/deletion/shared/deletion-tally';
import { manifest_roots_within } from '@/services/deletion/shared/manifest-roots';
import {
  delete_entries_in_batches,
  type BatchDeletionStorage,
  type DeletableEntry,
} from '@/services/deletion/shared/version-batch-deleter';

/** The slice of ObjectStorage that erasure needs. */
export interface DeletionStorage extends BatchDeletionStorage {
  list(prefix: string): Promise<string[]>;
  list_versions(prefix: string): Promise<readonly StorageObjectVersion[]>;
  readonly list_version_pages?: ObjectStorage['list_version_pages'];
}

/**
 * Deletes every version under each scope, where a scope is a key prefix or one exact key.
 *
 * Scopes run in the order given. Inside a scope, the manifest roots it contains are swept first
 * and the rest of the scope after, so an interrupted deletion leaves orphan blobs, which are
 * harmless and cleanable, rather than manifests pointing at data that is already gone. Each sweep
 * streams the listing a page at a time and deletes in batches (see `delete_entries_in_batches`).
 *
 * @param skip_prefixes - Scopes left untouched. A tenant purge uses this to hold
 *   the encrypted DEK back until the data it protects is confirmed gone.
 */
export async function delete_scopes(
  storage: DeletionStorage,
  scopes: readonly string[],
  skip_prefixes: readonly string[] = [],
): Promise<DeletionResult> {
  let summary: DeletionResult = empty_tally();
  for (const scope of scopes) {
    summary = merge_deletion_results(summary, await delete_scope(storage, scope, skip_prefixes));
  }
  return summary;
}

/** Sweeps the manifest roots inside one scope, then the rest of the scope without them. */
async function delete_scope(
  storage: DeletionStorage,
  scope: string,
  skip_prefixes: readonly string[],
): Promise<DeletionResult> {
  const manifest_roots = manifest_roots_within(scope);
  let summary: DeletionResult = empty_tally();
  for (const root of manifest_roots) {
    summary = merge_deletion_results(summary, await delete_prefix(storage, root, skip_prefixes));
  }
  const rest = await delete_prefix(storage, scope, [...skip_prefixes, ...manifest_roots]);
  return merge_deletion_results(summary, rest);
}

/** Deletes every version under one prefix, or every visible key when no version is listed. */
async function delete_prefix(
  storage: DeletionStorage,
  prefix: string,
  skip_prefixes: readonly string[],
): Promise<DeletionResult> {
  const listing = { entries: 0 };
  const versions = counted(versions_under(storage, prefix), listing);
  const summary = await delete_entries_in_batches(storage, unskipped(versions, skip_prefixes));
  if (listing.entries > 0) return summary;

  // No version listing: the visible key is all this backend can offer. A backend without versions
  // has no streaming listing either, so this one is held in full.
  const keys = (await storage.list(prefix)).map((key) => ({ key }));
  return delete_entries_in_batches(storage, unskipped(keys, skip_prefixes));
}

/** The versions under a prefix, a listing page at a time where the storage can page. */
async function* versions_under(
  storage: DeletionStorage,
  prefix: string,
): AsyncGenerator<StorageObjectVersion> {
  if (!storage.list_version_pages) {
    yield* await storage.list_versions(prefix);
    return;
  }
  for await (const page of storage.list_version_pages(prefix)) yield* page;
}

async function* counted<T>(
  entries: AsyncIterable<T>,
  listing: { entries: number },
): AsyncGenerator<T> {
  for await (const entry of entries) {
    listing.entries++;
    yield entry;
  }
}

async function* unskipped(
  entries: AsyncIterable<DeletableEntry> | Iterable<DeletableEntry>,
  skip_prefixes: readonly string[],
): AsyncGenerator<DeletableEntry> {
  for await (const entry of entries) {
    if (!is_skipped(entry.key, skip_prefixes)) yield entry;
  }
}

/** Adds two deletion summaries, for callers that erase in more than one pass. */
export function merge_deletion_results(a: DeletionResult, b: DeletionResult): DeletionResult {
  return {
    deleted_objects: a.deleted_objects + b.deleted_objects,
    deleted_manifests: a.deleted_manifests + b.deleted_manifests,
    retained_objects: a.retained_objects + b.retained_objects,
    retained_manifests: a.retained_manifests + b.retained_manifests,
    failed_objects: a.failed_objects + b.failed_objects,
    failed_manifests: a.failed_manifests + b.failed_manifests,
  };
}

/** True when anything survived the sweep, whether locked or merely broken. */
export function has_survivors(result: DeletionResult): boolean {
  return (
    result.retained_objects > 0 ||
    result.retained_manifests > 0 ||
    result.failed_objects > 0 ||
    result.failed_manifests > 0
  );
}

/**
 * Deletes one snapshot manifest by its exact key.
 *
 * Deleting an absent key succeeds on S3, so a sweep that found nothing is the only sign the
 * snapshot never existed. Raised as not found: an erasure script must not read it as done.
 */
export async function delete_snapshot_manifest(
  storage: DeletionStorage,
  manifest_key: string,
  workload: string,
  snapshot_id: string,
): Promise<DeletionResult> {
  const result = await delete_scopes(storage, [manifest_key]);
  if (result.deleted_manifests === 0 && !has_survivors(result)) {
    throw new NotFoundError(`No ${workload} manifest found for snapshot ${snapshot_id}`);
  }
  return result;
}

function is_skipped(key: string, skip_prefixes: readonly string[]): boolean {
  return skip_prefixes.some((prefix) => key.startsWith(prefix));
}
