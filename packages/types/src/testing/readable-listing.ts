import type { SnapshotSummary } from '@/domain/shared/snapshot-summary';
import type {
  LatestReadableManifest,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
  ReadableVersionIndexListing,
} from '@/ports/storage/readable-listing.port';

/** A `find_latest_readable` answer with nothing skipped. */
export function latest_readable<T>(manifest?: T): LatestReadableManifest<T> {
  return { manifest, unreadable_keys: [] };
}

/** A readable manifest listing with nothing skipped. */
export function readable_manifests<T>(manifests: T[] = []): ReadableManifestListing<T> {
  return { manifests, unreadable_keys: [] };
}

/** A snapshot summary listing with nothing skipped. */
export function readable_summaries<T>(summaries: T[] = []): ReadableSnapshotSummaries<T> {
  return { summaries, unreadable_keys: [] };
}

/** The summary row a manifest stored at `key_of(manifest)` would have, for repository stubs. */
export function summary_row<
  T extends { snapshot_id: string; created_at: Date; entries: readonly unknown[] },
>(manifest: T, key_of: (manifest: T) => string): SnapshotSummary {
  return {
    snapshot_id: manifest.snapshot_id,
    created_at: manifest.created_at,
    manifest_key: key_of(manifest),
    entry_count: manifest.entries.length,
    total_size_bytes: 0,
  };
}

/** A readable version index listing with nothing skipped. */
export function readable_indexes<T>(indexes: T[] = []): ReadableVersionIndexListing<T> {
  return { indexes, unreadable_keys: [] };
}
