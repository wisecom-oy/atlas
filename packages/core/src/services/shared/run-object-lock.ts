import type {
  MultipartUploadHandle,
  ObjectLockRequest,
  ObjectStorage,
  ObjectStorageEtagResult,
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
  StorageObjectLockPolicy,
  StorageObjectVersion,
  TenantContext,
} from '@wisecom/atlas-types';
import { compute_retain_until_utc } from '@/services/shared/object-lock-policy';

/**
 * Returns a context whose writes all carry the run's Object Lock policy, or `ctx` unchanged when no
 * retention was requested. Rejects before anything is written when the bucket cannot lock.
 *
 * Replaces bucket default retention for drive backups (#551). A bucket default is shared by every
 * run on the tenant, so two concurrent runs with different retention overwrote each other's
 * setting and one run's files were locked for the other's period. A policy carried by the run's
 * own context reaches every object it writes and nothing it does not.
 */
export async function lock_run_writes(
  ctx: TenantContext,
  request: ObjectLockRequest | undefined,
): Promise<TenantContext> {
  if (!request?.retention_days) return ctx;
  const policy: StorageObjectLockPolicy = {
    mode: request.mode ?? 'GOVERNANCE',
    retain_until: compute_retain_until_utc(request.retention_days),
  };
  await ctx.storage.validate_object_lock_policy(policy);
  return { ...ctx, storage: new ObjectLockingStorage(ctx.storage, policy) };
}

/**
 * Storage decorator that applies one Object Lock policy to every object it creates: puts, copies
 * and multipart uploads. A caller that passes its own policy keeps it. Reads and deletes pass
 * through unchanged.
 */
export class ObjectLockingStorage implements ObjectStorage {
  constructor(
    private readonly _inner: ObjectStorage,
    private readonly _policy: StorageObjectLockPolicy,
  ) {}

  /** Writes with the run's policy unless the caller supplied one. */
  put(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
    if_match?: string,
    if_none_match?: boolean,
  ): Promise<void> {
    const policy = object_lock_policy ?? this._policy;
    return this._inner.put(key, data, metadata, policy, if_match, if_none_match);
  }

  /** Starts a multipart upload with the run's policy unless the caller supplied one. */
  begin_multipart_upload(
    key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<MultipartUploadHandle> {
    return this._inner.begin_multipart_upload(key, metadata, object_lock_policy ?? this._policy);
  }

  /** Copies with the run's policy unless the caller supplied one. */
  copy(
    source_key: string,
    dest_key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<void> {
    return this._inner.copy(source_key, dest_key, metadata, object_lock_policy ?? this._policy);
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

  /** Removes an object. */
  delete(key: string): Promise<void> {
    return this._inner.delete(key);
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

  /** Deletes one object version. */
  delete_version(key: string, version_id: string): Promise<void> {
    return this._inner.delete_version(key, version_id);
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

  /** Lists keys under a prefix last modified before `older_than`. */
  list_stale(prefix: string, older_than: Date): Promise<string[]> {
    return this._inner.list_stale(prefix, older_than);
  }

  /** Aborts incomplete multipart uploads under a prefix older than `older_than`. */
  abort_incomplete_uploads(prefix: string, older_than: Date): Promise<number> {
    return this._inner.abort_incomplete_uploads(prefix, older_than);
  }
}
