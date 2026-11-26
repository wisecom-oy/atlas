export type StorageObjectLockMode = 'GOVERNANCE' | 'COMPLIANCE';

export interface StorageObjectLockPolicy {
  readonly mode?: StorageObjectLockMode | undefined;
  readonly retain_until?: string | undefined;
}

export interface StorageImmutabilityProbeRequest {
  readonly mode?: StorageObjectLockMode | undefined;
  readonly retain_until?: string | undefined;
}

export interface StorageImmutabilityProbeResult {
  readonly bucket: string;
  readonly reachable: boolean;
  readonly versioning_enabled: boolean;
  readonly object_lock_enabled: boolean;
  readonly mode_supported: boolean;
}

export interface StorageObjectVersion {
  readonly key: string;
  readonly version_id: string;
  readonly is_delete_marker: boolean;
  /**
   * True for the version a plain GET returns, false for a noncurrent one, and absent when the
   * listing did not say. Anything that deletes only noncurrent versions must test for `false`,
   * so an adapter that leaves it out deletes nothing.
   */
  readonly is_latest?: boolean;
}

/** One object or object version to delete. Without `version_id` the visible key is deleted. */
export interface StorageDeleteTarget {
  readonly key: string;
  readonly version_id?: string | undefined;
}

/**
 * What became of one delete target. `retained` means Object Lock retention or a legal hold
 * refused it; every other refusal is `failed`, so an IAM gap is never reported as retained.
 */
export type StorageDeleteOutcome = 'deleted' | 'retained' | 'failed';

/** The object a completed multipart upload created. */
export interface CompletedMultipartUpload {
  /**
   * The version the completion created, absent when the bucket keeps no versions or the backend
   * did not report one. A caller that has to remove the object's bytes deletes this version: a
   * delete without it only adds a delete marker in a versioned bucket (issue #795).
   */
  readonly version_id?: string | undefined;
}

export interface MultipartUploadHandle {
  /** Uploads a single part. Returns the ETag for assembly. */
  upload_part(part_number: number, data: Buffer): Promise<string>;

  /** Finalises the multipart upload, assembling parts in order, and names the object it created. */
  complete(parts: Array<{ ETag: string; PartNumber: number }>): Promise<CompletedMultipartUpload>;

  /** Aborts the upload and removes uploaded parts (best-effort). */
  abort(): Promise<void>;
}

export interface ObjectStorageEtagResult {
  readonly data: Buffer;
  readonly etag: string;
}

export interface ObjectStorage {
  /**
   * Writes an object to storage under the given key.
   * `if_match` performs a compare-and-swap on the ETag; `if_none_match` makes
   * the write create-only (fails if the key exists). Both reject with a
   * precondition error (HTTP 412) when the condition does not hold.
   */
  put(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
    if_match?: string,
    if_none_match?: boolean,
  ): Promise<void>;

  /** Reads the full content of an object from storage. */
  get(key: string): Promise<Buffer>;

  /** Reads an object along with its ETag for conditional writes. */
  get_with_etag(key: string): Promise<ObjectStorageEtagResult>;

  /** Returns a readable stream for an object (avoids buffering the full body). */
  get_stream(key: string): Promise<NodeJS.ReadableStream>;

  /** Removes an object from storage. */
  delete(key: string): Promise<void>;

  /** Returns true if the key exists in storage. */
  exists(key: string): Promise<boolean>;

  /**
   * Lists keys that share the given prefix. `limit` caps the number of keys
   * returned and stops enumeration early - use it for cheap existence checks
   * on potentially large buckets.
   */
  list(prefix: string, limit?: number): Promise<string[]>;

  /** Lists object versions and delete markers for a prefix. */
  list_versions(prefix: string): Promise<StorageObjectVersion[]>;

  /** Deletes a specific object version or delete marker. */
  delete_version(key: string, version_id: string): Promise<void>;

  /**
   * Lists the versions and delete markers under a prefix one listing page at a time, so a caller
   * that walks a whole bucket holds one page instead of every version. Optional: without it a
   * caller falls back to `list_versions`.
   */
  readonly list_version_pages?:
    ((prefix: string) => AsyncIterable<readonly StorageObjectVersion[]>) | undefined;

  /**
   * Deletes up to 1,000 targets (the S3 `DeleteObjects` limit) and returns one outcome per target, in
   * the order given. A refusal of one target never rejects the call; a call that rejects left no
   * outcome it could vouch for. An adapter whose backend cannot delete in bulk deletes one target
   * per request behind this method. Optional: without it a caller uses `delete_version`.
   */
  readonly delete_batch?:
    ((targets: readonly StorageDeleteTarget[]) => Promise<StorageDeleteOutcome[]>) | undefined;

  /**
   * Reads one specific version of an object. Optional: an adapter without it cannot serve a
   * caller that must inspect old versions, and that caller refuses rather than guessing.
   */
  readonly get_version?: ((key: string, version_id: string) => Promise<Buffer>) | undefined;

  /** Validates bucket immutability readiness for optional lock policy. */
  probe_immutability(
    request?: StorageImmutabilityProbeRequest,
  ): Promise<StorageImmutabilityProbeResult>;

  /**
   * Rejects unless the bucket can honour `policy`: versioning on, Object Lock enabled, and the
   * mode accepted. Every locked write runs the same check, so calling it first only moves the
   * failure ahead of work that would otherwise be thrown away.
   */
  validate_object_lock_policy(policy: StorageObjectLockPolicy): Promise<void>;

  /** Starts a multipart upload, returning a handle for part-level control. */
  begin_multipart_upload(
    key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<MultipartUploadHandle>;

  /** Server-side copy from source to destination within the same bucket. */
  copy(
    source_key: string,
    dest_key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<void>;

  /**
   * Lists keys under a prefix last modified before `older_than`.
   *
   * Startup cleanup has no other way to tell an abandoned staging object from one a concurrent run
   * is about to copy, and deleting the second breaks that run (issue #345).
   */
  list_stale(prefix: string, older_than: Date): Promise<string[]>;

  /**
   * Aborts incomplete multipart uploads under the prefix that started before `older_than`, and
   * returns how many.
   *
   * The cutoff is required rather than optional: an unfiltered sweep of an owner prefix aborts the
   * upload a concurrent backup is streaming into, which fails that run with `NoSuchUpload` on its
   * next part (issue #345).
   */
  abort_incomplete_uploads(prefix: string, older_than: Date): Promise<number>;
}
