/**
 * Every manifest a listing could read, plus the keys of the ones it could not.
 *
 * A manifest that fails to decrypt, parse, or identify as its key is skipped and named here rather
 * than failing the whole listing, so one damaged object does not hide an owner's other snapshots
 * (issue #631). Absent objects are neither listed nor named.
 */
export interface ReadableManifestListing<T> {
  readonly manifests: T[];
  readonly unreadable_keys: string[];
}

/**
 * The newest manifest that could be read, plus the keys of damaged manifests the read came across.
 *
 * A read that stops at the first readable manifest, newest first, never downloads the older ones,
 * so a damaged manifest older than the one returned may go unnamed.
 */
export interface LatestReadableManifest<T> {
  readonly manifest: T | undefined;
  readonly unreadable_keys: string[];
}

/** Every version index row a listing could read, plus the keys of index objects it could not. */
export interface ReadableVersionIndexListing<T> {
  readonly indexes: T[];
  readonly unreadable_keys: string[];
}
