import type {
  LatestReadableManifest,
  ReadableManifestListing,
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

/** A readable version index listing with nothing skipped. */
export function readable_indexes<T>(indexes: T[] = []): ReadableVersionIndexListing<T> {
  return { indexes, unreadable_keys: [] };
}
