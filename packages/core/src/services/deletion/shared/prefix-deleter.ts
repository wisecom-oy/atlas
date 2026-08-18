/**
 * The single deletion primitive behind Outlook, OneDrive and SharePoint erasure.
 *
 * Deleting a key without a version id is not erasure. In a versioned bucket --
 * the prerequisite for Object Lock, so every immutability deployment has one --
 * `DeleteObject` writes a delete marker and leaves the bytes retrievable as a
 * noncurrent version. Everything here therefore deletes by version id, and falls
 * back to plain keys only for backends that do not enumerate versions.
 */

import type { DeletionResult, StorageObjectVersion } from '@wisecom/atlas-types';

/** The slice of ObjectStorage that erasure needs. */
export interface DeletionStorage {
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  list_versions(prefix: string): Promise<readonly StorageObjectVersion[]>;
  delete_version(key: string, version_id: string): Promise<void>;
}

type MutableResult = {
  deleted_objects: number;
  deleted_manifests: number;
  retained_objects: number;
  retained_manifests: number;
  failed_objects: number;
  failed_manifests: number;
};

/**
 * Deletes every version under each scope, where a scope is a key prefix or one
 * exact key.
 *
 * ponytail: one listing buffered per scope, one DELETE per version, measured at
 * ~1500 versions in 2.6s. Fine for a tenant; if million-object buckets show up,
 * switch to the DeleteObjects batch API (1000 per call) and map its per-key
 * error entries onto the same retained/failed split.
 *
 * @param skip_prefixes - Scopes left untouched. A tenant purge uses this to hold
 *   the encrypted DEK back until the data it protects is confirmed gone.
 */
export async function delete_scopes(
  storage: DeletionStorage,
  scopes: readonly string[],
  skip_prefixes: readonly string[] = [],
): Promise<DeletionResult> {
  const summary = empty_summary();

  for (const scope of scopes) {
    const versions = await storage.list_versions(scope);

    if (versions.length > 0) {
      for (const version of manifests_first(versions, (v) => v.key)) {
        if (is_skipped(version.key, skip_prefixes)) continue;
        await delete_one(storage, version, summary);
      }
      continue;
    }

    // No version listing: the visible key is all this backend can offer.
    for (const key of manifests_first(await storage.list(scope), (k) => k)) {
      if (is_skipped(key, skip_prefixes)) continue;
      await delete_one(storage, { key }, summary);
    }
  }

  return { ...summary };
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

/** An all-zero summary, for callers that find nothing to delete. */
export function empty_deletion_result(): DeletionResult {
  return empty_summary();
}

function is_skipped(key: string, skip_prefixes: readonly string[]): boolean {
  return skip_prefixes.some((prefix) => key.startsWith(prefix));
}

/**
 * Orders manifests ahead of the objects they reference.
 *
 * An interrupted deletion then leaves orphan blobs, which are harmless and
 * cleanable, rather than manifests pointing at data that is already gone.
 * Sweeping a whole bucket would otherwise hit `data/` long before `manifests/`.
 */
function manifests_first<T>(entries: readonly T[], key_of: (entry: T) => string): T[] {
  return [...entries].sort(
    (a, b) => Number(is_manifest_key(key_of(b))) - Number(is_manifest_key(key_of(a))),
  );
}

/** True for manifest keys at any depth: `manifests/…` and `onedrive/manifests/…`. */
function is_manifest_key(key: string): boolean {
  return key.split('/').includes('manifests');
}

async function delete_one(
  storage: DeletionStorage,
  entry: StorageObjectVersion | { key: string },
  summary: MutableResult,
): Promise<void> {
  const version_id = 'version_id' in entry ? entry.version_id : undefined;
  try {
    if (version_id === undefined) await storage.delete(entry.key);
    else await storage.delete_version(entry.key, version_id);
    count(summary, entry, 'deleted');
  } catch (err) {
    count(summary, entry, is_object_lock_delete_error(err) ? 'retained' : 'failed');
  }
}

function count(
  summary: MutableResult,
  entry: StorageObjectVersion | { key: string },
  outcome: 'deleted' | 'retained' | 'failed',
): void {
  // Removing a delete marker uncovers the versions beneath it rather than
  // erasing anything, so a successful sweep of one is not counted as data. A
  // marker we could not remove still counts: it is an entry that outlived the
  // sweep, and a purge must not read the summary as clean and drop the DEK.
  if (outcome === 'deleted' && 'is_delete_marker' in entry && entry.is_delete_marker === true) {
    return;
  }

  const kind = is_manifest_key(entry.key) ? 'manifests' : 'objects';
  summary[`${outcome}_${kind}` as keyof MutableResult]++;
}

/**
 * True only for errors that name Object Lock as the reason a delete was refused.
 *
 * Backends word it differently -- MinIO raises `InvalidRequest` "Object is WORM
 * protected and cannot be overwritten", AWS raises `AccessDenied` "Access Denied
 * because object protected by object lock" -- but both name the mechanism. A
 * bare `AccessDenied` from a missing IAM permission does not, and must not be
 * filed as "retained, deletable once retention expires". On an erasure report a
 * false alarm costs an investigation; a false all-clear costs the erasure.
 */
function is_object_lock_delete_error(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name} ${err.message}`.toLowerCase() : '';
  return (
    message.includes('object lock') ||
    message.includes('objectlock') ||
    message.includes('worm protected') ||
    message.includes('retention') ||
    message.includes('legal hold')
  );
}

function empty_summary(): MutableResult {
  return {
    deleted_objects: 0,
    deleted_manifests: 0,
    retained_objects: 0,
    retained_manifests: 0,
    failed_objects: 0,
    failed_manifests: 0,
  };
}
