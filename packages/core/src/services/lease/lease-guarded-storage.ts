import type {
  MultipartUploadHandle,
  ObjectStorage,
  ObjectStorageEtagResult,
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
  StorageObjectLockPolicy,
  StorageObjectVersion,
} from '@wisecom/atlas-types';
import type { HeldLease } from '@/services/lease/held-lease';

/**
 * Storage decorator that refuses every write once the run's lease is lost, with
 * `OwnerLeaseLostError`. Reads pass through.
 *
 * This is what turns an overlap into an error rather than lost state: the cursors, pointers and
 * checkpoint deletes a run commits at its end all go through here, so a run that lost its lease
 * cannot overwrite what the run that took over has written. A multipart upload is checked when it
 * starts; its parts land under a content-addressed key that nothing references until a guarded
 * write commits it.
 */
export class LeaseGuardedStorage implements ObjectStorage {
  constructor(
    private readonly _inner: ObjectStorage,
    private readonly _lease: HeldLease,
  ) {}

  /** Writes while the lease is held. */
  put(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
    if_match?: string,
    if_none_match?: boolean,
  ): Promise<void> {
    return this.whileHeld(() =>
      this._inner.put(key, data, metadata, object_lock_policy, if_match, if_none_match),
    );
  }

  /** Starts a multipart upload while the lease is held. */
  begin_multipart_upload(
    key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<MultipartUploadHandle> {
    return this.whileHeld(() =>
      this._inner.begin_multipart_upload(key, metadata, object_lock_policy),
    );
  }

  /** Copies while the lease is held. */
  copy(
    source_key: string,
    dest_key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<void> {
    return this.whileHeld(() =>
      this._inner.copy(source_key, dest_key, metadata, object_lock_policy),
    );
  }

  /** Removes an object while the lease is held. */
  delete(key: string): Promise<void> {
    return this.whileHeld(() => this._inner.delete(key));
  }

  /** Deletes one object version while the lease is held. */
  delete_version(key: string, version_id: string): Promise<void> {
    return this.whileHeld(() => this._inner.delete_version(key, version_id));
  }

  /** Aborts stale multipart uploads while the lease is held. */
  abort_incomplete_uploads(prefix: string, older_than: Date): Promise<number> {
    return this.whileHeld(() => this._inner.abort_incomplete_uploads(prefix, older_than));
  }

  /** Reads an object. */
  get(key: string): Promise<Buffer> {
    return this._inner.get(key);
  }

  /** Reads an object with its ETag. */
  get_with_etag(key: string): Promise<ObjectStorageEtagResult> {
    return this._inner.get_with_etag(key);
  }

  /** Streams an object. */
  get_stream(key: string): Promise<NodeJS.ReadableStream> {
    return this._inner.get_stream(key);
  }

  /** Reports whether a key exists. */
  exists(key: string): Promise<boolean> {
    return this._inner.exists(key);
  }

  /** Lists keys under a prefix. */
  list(prefix: string, limit?: number): Promise<string[]> {
    return this._inner.list(prefix, limit);
  }

  /** Lists object versions under a prefix. */
  list_versions(prefix: string): Promise<StorageObjectVersion[]> {
    return this._inner.list_versions(prefix);
  }

  /** Lists keys under a prefix last modified before `older_than`. */
  list_stale(prefix: string, older_than: Date): Promise<string[]> {
    return this._inner.list_stale(prefix, older_than);
  }

  /** Probes bucket immutability readiness. */
  probe_immutability(
    request?: StorageImmutabilityProbeRequest,
  ): Promise<StorageImmutabilityProbeResult> {
    return this._inner.probe_immutability(request);
  }

  /** Rejects unless the bucket can honour `policy`. */
  validate_object_lock_policy(policy: StorageObjectLockPolicy): Promise<void> {
    return this._inner.validate_object_lock_policy(policy);
  }

  /** Runs one write after checking the lease; a lost lease rejects without touching storage. */
  private async whileHeld<T>(write: () => Promise<T>): Promise<T> {
    this._lease.assert_held();
    return write();
  }
}
