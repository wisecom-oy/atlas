import {
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { ObjectLockRetainedError, StorageError } from '@wisecom/atlas-types';
import type {
  ObjectStorage,
  ObjectStorageEtagResult,
  MultipartUploadHandle,
  StorageConditionalWriteCheck,
  StorageDeleteOutcome,
  StorageDeleteTarget,
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
  StorageObjectLockPolicy,
  StorageObjectVersion,
} from '@wisecom/atlas-types';
import { probe_bucket_immutability } from '@/adapters/s3-bucket-manager';
import type { BucketCache } from '@/adapters/bucket-cache';
import { abort_incomplete_multipart_uploads } from '@/adapters/s3-multipart-cleanup';
import { S3MultipartUploadHandle } from '@/adapters/s3-multipart-upload-handle';
import { is_object_lock_refusal } from '@/adapters/s3-error-classifier';
import {
  ObjectLockModeRejectedError,
  ObjectLockUnsupportedError,
  ObjectLockVersioningDisabledError,
} from '@/adapters/object-lock.errors';
import { is_backend_mode_rejection } from '@/adapters/s3-error-classifier';
import { copy_object_server_side } from '@/adapters/s3-large-copy';
import {
  list_object_version_pages,
  list_object_versions,
} from '@/adapters/s3-object-version-listing';
import { S3BatchDeleter } from '@/adapters/s3-batch-delete';
import { is_conditional_put, send_put_object } from '@/adapters/s3-object-put';
import { require_conditional_writes } from '@/adapters/conditional-write-guard';
import {
  probe_conditional_writes,
  run_conditional_write_probe,
  type ConditionalWriteProbeTarget,
} from '@/adapters/s3-conditional-write-probe';

/**
 * S3-backed ObjectStorage scoped to a single bucket.
 * Not injectable -- created by TenantContextFactory per tenant.
 */
export class S3ObjectStorage implements ObjectStorage {
  private readonly _batch_deleter: S3BatchDeleter;

  constructor(
    private readonly _client: S3Client,
    private readonly _bucket: string,
    private readonly _buckets: BucketCache,
  ) {
    this._batch_deleter = new S3BatchDeleter(_client, _bucket, (target) =>
      target.version_id === undefined
        ? this.delete(target.key)
        : this.delete_version(target.key, target.version_id),
    );
  }

  /**
   * Uploads data with a Content-MD5 header for transport integrity verification. A conditional
   * write first confirms, once per bucket and process, that the backend enforces conditions.
   *
   * @throws ConditionalWritesNotEnforcedError on a conditional write to a backend that ignores it.
   */
  async put(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
    if_match?: string,
    if_none_match?: boolean,
  ): Promise<void> {
    await this.validate_object_lock_policy(object_lock_policy);
    const request = { key, data, metadata, object_lock_policy, if_match, if_none_match };
    if (is_conditional_put(request)) {
      await require_conditional_writes(this._bucket, this._buckets, () =>
        run_conditional_write_probe(this.unguarded_probe_target()),
      );
    }
    await send_put_object(this._client, this._bucket, request);
  }

  /** Probes this bucket's conditional-write rules without the cache, for `storage-check`. */
  async check_conditional_writes(): Promise<StorageConditionalWriteCheck> {
    return probe_conditional_writes(this.unguarded_probe_target());
  }

  /** Probes bucket-level immutability readiness. */
  async probe_immutability(
    request: StorageImmutabilityProbeRequest = {},
  ): Promise<StorageImmutabilityProbeResult> {
    return probe_bucket_immutability(this._client, this._bucket, this._buckets, request);
  }

  /** Downloads the full object and returns it as a Buffer. */
  async get(key: string): Promise<Buffer> {
    const response = await this._client.send(
      new GetObjectCommand({ Bucket: this._bucket, Key: key }),
    );

    const stream = response.Body;
    if (!stream) throw new Error(`Empty response body for key ${key}`);

    return Buffer.from(await stream.transformToByteArray());
  }

  /** Reads one specific version of an object. */
  async get_version(key: string, version_id: string): Promise<Buffer> {
    const response = await this._client.send(
      new GetObjectCommand({ Bucket: this._bucket, Key: key, VersionId: version_id }),
    );
    const stream = response.Body;
    if (!stream) throw new Error(`Empty response body for key ${key} version ${version_id}`);
    return Buffer.from(await stream.transformToByteArray());
  }

  /** Returns a readable stream for an object. */
  async get_stream(key: string): Promise<NodeJS.ReadableStream> {
    const response = await this._client.send(
      new GetObjectCommand({ Bucket: this._bucket, Key: key }),
    );
    const stream = response.Body;
    if (!stream) throw new Error(`Empty response body for key ${key}`);
    return stream as unknown as NodeJS.ReadableStream;
  }

  /** Downloads an object along with its ETag for subsequent conditional writes. */
  async get_with_etag(key: string): Promise<ObjectStorageEtagResult> {
    const response = await this._client.send(
      new GetObjectCommand({ Bucket: this._bucket, Key: key }),
    );

    const stream = response.Body;
    if (!stream) throw new Error(`Empty response body for key ${key}`);

    const data = Buffer.from(await stream.transformToByteArray());
    const etag = response.ETag ?? '';
    return { data, etag };
  }

  /** Removes a single object. @throws ObjectLockRetainedError when retention refuses the delete. */
  async delete(key: string): Promise<void> {
    try {
      await this._client.send(new DeleteObjectCommand({ Bucket: this._bucket, Key: key }));
    } catch (err) {
      throw as_delete_failure(key, err);
    }
  }

  /**
   * Removes a specific object version (or delete marker) by version id.
   *
   * @throws ObjectLockRetainedError when retention or a legal hold refuses the delete.
   */
  async delete_version(key: string, version_id: string): Promise<void> {
    try {
      await this._client.send(
        new DeleteObjectCommand({ Bucket: this._bucket, Key: key, VersionId: version_id }),
      );
    } catch (err) {
      throw as_delete_failure(key, err);
    }
  }

  /**
   * Deletes up to 1,000 objects or versions with one `DeleteObjects` request, mapping each key's
   * error onto retained or failed. A backend that refuses the bulk request gets one delete per
   * target from then on.
   */
  delete_batch(targets: readonly StorageDeleteTarget[]): Promise<StorageDeleteOutcome[]> {
    return this._batch_deleter.delete_batch(targets);
  }

  /** Returns true if the object exists (HEAD request). */
  async exists(key: string): Promise<boolean> {
    try {
      await this._client.send(new HeadObjectCommand({ Bucket: this._bucket, Key: key }));
      return true;
    } catch (err) {
      const code = (err as { name?: string }).name;
      if (code === 'NotFound' || code === 'NoSuchKey') return false;
      throw err;
    }
  }

  /** Lists keys sharing the given prefix; `limit` stops enumeration early. */
  async list(prefix: string, limit?: number): Promise<string[]> {
    return this.collect_keys(prefix, () => true, limit);
  }

  /**
   * Lists keys under the prefix last modified before `older_than`.
   *
   * An object with no reported timestamp cannot be shown to be abandoned, so it stays.
   */
  async list_stale(prefix: string, older_than: Date): Promise<string[]> {
    return this.collect_keys(
      prefix,
      (last_modified) => last_modified !== undefined && last_modified < older_than,
    );
  }

  /** One paginated walk; the two listings differ only in what they keep and when they stop. */
  private async collect_keys(
    prefix: string,
    keep: (last_modified: Date | undefined) => boolean,
    limit?: number,
  ): Promise<string[]> {
    const keys: string[] = [];
    let continuation_token: string | undefined;

    do {
      const response = await this._client.send(
        new ListObjectsV2Command({
          Bucket: this._bucket,
          Prefix: prefix,
          ContinuationToken: continuation_token,
          ...(limit !== undefined ? { MaxKeys: Math.min(limit, 1000) } : {}),
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (obj.Key && keep(obj.LastModified)) keys.push(obj.Key);
      }
      if (limit !== undefined && keys.length >= limit) return keys.slice(0, limit);
      continuation_token = response.NextContinuationToken;
    } while (continuation_token);

    return keys;
  }

  /** Lists all object versions and delete markers under a prefix. */
  async list_versions(prefix: string): Promise<StorageObjectVersion[]> {
    return list_object_versions(this._client, this._bucket, prefix);
  }

  /** Yields the versions and delete markers under a prefix one listing page at a time. */
  list_version_pages(prefix: string): AsyncIterable<StorageObjectVersion[]> {
    return list_object_version_pages(this._client, this._bucket, prefix);
  }

  /** Starts a multipart upload with optional metadata and object lock. */
  async begin_multipart_upload(
    key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<MultipartUploadHandle> {
    await this.validate_object_lock_policy(object_lock_policy);
    try {
      const response = await this._client.send(
        new CreateMultipartUploadCommand({
          Bucket: this._bucket,
          Key: key,
          Metadata: metadata,
          ObjectLockMode: object_lock_policy?.mode,
          ObjectLockRetainUntilDate: object_lock_policy?.retain_until
            ? new Date(object_lock_policy.retain_until)
            : undefined,
        }),
      );
      if (!response.UploadId) throw new StorageError('CreateMultipartUpload returned no UploadId');
      return new S3MultipartUploadHandle(this._client, this._bucket, key, response.UploadId);
    } catch (err) {
      if (is_backend_mode_rejection(err, object_lock_policy?.mode)) {
        throw new ObjectLockModeRejectedError(
          this._bucket,
          object_lock_policy?.mode ?? 'UNKNOWN',
          err,
        );
      }
      throw err;
    }
  }

  /**
   * Copies an object server-side within this bucket.
   *
   * A single `CopyObject` is limited to a 5 GB source, which is smaller than the objects the
   * multipart upload path accepts, so promotion used to fail on a large file after its bytes were
   * already uploaded. The source size decides the request: anything above the limit is copied as
   * ranged `UploadPartCopy` parts instead (issue #346).
   */
  async copy(
    source_key: string,
    dest_key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<void> {
    await this.validate_object_lock_policy(object_lock_policy);
    try {
      await copy_object_server_side(this._client, {
        bucket: this._bucket,
        source_key,
        dest_key,
        metadata,
        object_lock_policy,
      });
    } catch (err) {
      if (is_backend_mode_rejection(err, object_lock_policy?.mode)) {
        throw new ObjectLockModeRejectedError(
          this._bucket,
          object_lock_policy?.mode ?? 'UNKNOWN',
          err,
        );
      }
      throw err;
    }
  }

  /** Lists and aborts incomplete multipart uploads under {@link prefix}; returns count aborted. */
  async abort_incomplete_uploads(prefix: string, older_than: Date): Promise<number> {
    const swept = await abort_incomplete_multipart_uploads(
      this._client,
      this._bucket,
      prefix,
      older_than,
    );
    return swept.aborted;
  }

  /** This bucket's storage calls with puts that skip the guard, which would await the probe. */
  private unguarded_probe_target(): ConditionalWriteProbeTarget {
    return {
      put: (key, data, metadata, object_lock_policy, if_match, if_none_match) =>
        send_put_object(this._client, this._bucket, {
          key,
          data,
          metadata,
          object_lock_policy,
          if_match,
          if_none_match,
        }),
      get_with_etag: (key) => this.get_with_etag(key),
      delete: (key) => this.delete(key),
      list_versions: (prefix) => this.list_versions(prefix),
      delete_version: (key, version_id) => this.delete_version(key, version_id),
    };
  }

  /** Rejects unless the bucket can honour the policy; a policy without `retain_until` passes. */
  async validate_object_lock_policy(policy?: StorageObjectLockPolicy): Promise<void> {
    if (!policy || !policy.retain_until) return;
    const probe = await this.probe_immutability({ mode: policy.mode });
    if (!probe.versioning_enabled) throw new ObjectLockVersioningDisabledError(this._bucket);
    if (!probe.object_lock_enabled) throw new ObjectLockUnsupportedError(this._bucket);
    if (!probe.mode_supported)
      throw new ObjectLockModeRejectedError(this._bucket, policy.mode ?? 'UNKNOWN');
  }
}

/**
 * Names a refused delete for what it is. Retention and legal holds are an expected outcome a
 * caller reports as retained; anything else is a failure it must not file as recoverable.
 */
function as_delete_failure(key: string, err: unknown): Error {
  if (is_object_lock_refusal(err)) return new ObjectLockRetainedError(key, { cause: err });
  return err instanceof Error ? err : new Error(String(err));
}
