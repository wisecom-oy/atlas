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
}

export interface MultipartUploadHandle {
  /** Uploads a single part. Returns the ETag for assembly. */
  upload_part(part_number: number, data: Buffer): Promise<string>;

  /** Finalises the multipart upload, assembling parts in order. */
  complete(parts: Array<{ ETag: string; PartNumber: number }>): Promise<void>;

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

  /** Validates bucket immutability readiness for optional lock policy. */
  probe_immutability(
    request?: StorageImmutabilityProbeRequest,
  ): Promise<StorageImmutabilityProbeResult>;

  /**
   * Sets the bucket's Object Lock default retention: every new object version
   * inherits the lock automatically, so no write path can forget it. Persists
   * on the bucket until replaced. Requires a lock-capable bucket (rejects
   * otherwise).
   */
  apply_default_retention(mode: StorageObjectLockMode, retention_days: number): Promise<void>;

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
