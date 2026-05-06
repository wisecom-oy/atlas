import { createHash } from 'node:crypto';
import {
  S3ServiceException,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  CopyObjectCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type {
  ObjectStorage,
  MultipartUploadHandle,
  StorageImmutabilityProbeRequest,
  StorageImmutabilityProbeResult,
  StorageObjectLockPolicy,
} from '@atlas/types';
import { probe_bucket_immutability } from '@/adapters/s3-bucket-manager';
import { S3MultipartUploadHandle } from '@/adapters/s3-multipart-upload-handle';
import {
  ObjectLockModeRejectedError,
  ObjectLockUnsupportedError,
  ObjectLockVersioningDisabledError,
} from '@/adapters/object-lock.errors';

/**
 * S3-backed ObjectStorage scoped to a single bucket.
 * Not injectable -- created by TenantContextFactory per tenant.
 */
export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly _client: S3Client,
    private readonly _bucket: string,
  ) {}

  /** Uploads data with a Content-MD5 header for transport integrity verification. */
  async put(
    key: string,
    data: Buffer,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<void> {
    await this.validate_immutability_policy(object_lock_policy);
    const content_md5 = createHash('md5').update(data).digest('base64');

    try {
      await this._client.send(
        new PutObjectCommand({
          Bucket: this._bucket,
          Key: key,
          Body: data,
          ContentMD5: content_md5,
          Metadata: metadata,
          ObjectLockMode: object_lock_policy?.mode,
          ObjectLockRetainUntilDate: object_lock_policy?.retain_until
            ? new Date(object_lock_policy.retain_until)
            : undefined,
        }),
      );
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

  /** Probes bucket-level immutability readiness. */
  async probe_immutability(
    request: StorageImmutabilityProbeRequest = {},
  ): Promise<StorageImmutabilityProbeResult> {
    return probe_bucket_immutability(this._client, this._bucket, request);
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

  /** Removes a single object. */
  async delete(key: string): Promise<void> {
    await this._client.send(new DeleteObjectCommand({ Bucket: this._bucket, Key: key }));
  }

  /** Removes a specific object version (or delete marker) by version id. */
  async delete_version(key: string, version_id: string): Promise<void> {
    await this._client.send(
      new DeleteObjectCommand({ Bucket: this._bucket, Key: key, VersionId: version_id }),
    );
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

  /** Lists all keys sharing the given prefix. */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuation_token: string | undefined;

    do {
      const response = await this._client.send(
        new ListObjectsV2Command({
          Bucket: this._bucket,
          Prefix: prefix,
          ContinuationToken: continuation_token,
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuation_token = response.NextContinuationToken;
    } while (continuation_token);

    return keys;
  }

  /** Lists all object versions and delete markers under a prefix. */
  async list_versions(
    prefix: string,
  ): Promise<{ key: string; version_id: string; is_delete_marker: boolean }[]> {
    const versions: { key: string; version_id: string; is_delete_marker: boolean }[] = [];
    let key_marker: string | undefined;
    let version_id_marker: string | undefined;

    do {
      const response = await this._client.send(
        new ListObjectVersionsCommand({
          Bucket: this._bucket,
          Prefix: prefix,
          KeyMarker: key_marker,
          VersionIdMarker: version_id_marker,
        }),
      );

      for (const version of response.Versions ?? []) {
        if (version.Key && version.VersionId) {
          versions.push({
            key: version.Key,
            version_id: version.VersionId,
            is_delete_marker: false,
          });
        }
      }

      for (const marker of response.DeleteMarkers ?? []) {
        if (marker.Key && marker.VersionId) {
          versions.push({
            key: marker.Key,
            version_id: marker.VersionId,
            is_delete_marker: true,
          });
        }
      }

      key_marker = response.NextKeyMarker;
      version_id_marker = response.NextVersionIdMarker;
      if (!response.IsTruncated) break;
    } while (true);

    return versions;
  }

  /** Starts a multipart upload with optional metadata and object lock. */
  async begin_multipart_upload(
    key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<MultipartUploadHandle> {
    await this.validate_immutability_policy(object_lock_policy);
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
      if (!response.UploadId) throw new Error('CreateMultipartUpload returned no UploadId');
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

  /** Copies an object server-side within this bucket. */
  async copy(
    source_key: string,
    dest_key: string,
    metadata?: Record<string, string>,
    object_lock_policy?: StorageObjectLockPolicy,
  ): Promise<void> {
    await this.validate_immutability_policy(object_lock_policy);
    const copy_source = build_s3_copy_source(this._bucket, source_key);
    try {
      await this._client.send(
        new CopyObjectCommand({
          Bucket: this._bucket,
          Key: dest_key,
          CopySource: copy_source,
          Metadata: metadata,
          MetadataDirective: metadata ? 'REPLACE' : undefined,
          ObjectLockMode: object_lock_policy?.mode,
          ObjectLockRetainUntilDate: object_lock_policy?.retain_until
            ? new Date(object_lock_policy.retain_until)
            : undefined,
        }),
      );
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
  async abort_incomplete_uploads(prefix: string): Promise<number> {
    let aborted = 0;
    let key_marker: string | undefined;
    let upload_id_marker: string | undefined;

    for (;;) {
      const response = await this._client.send(
        new ListMultipartUploadsCommand({
          Bucket: this._bucket,
          Prefix: prefix,
          KeyMarker: key_marker,
          UploadIdMarker: upload_id_marker,
        }),
      );

      for (const upload of response.Uploads ?? []) {
        if (upload.Key && upload.UploadId) {
          await this._client.send(
            new AbortMultipartUploadCommand({
              Bucket: this._bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
          );
          aborted += 1;
        }
      }

      if (!response.IsTruncated) break;
      key_marker = response.NextKeyMarker;
      upload_id_marker = response.NextUploadIdMarker;
    }

    return aborted;
  }

  private async validate_immutability_policy(policy?: StorageObjectLockPolicy): Promise<void> {
    if (!policy || !policy.retain_until) return;
    const probe = await this.probe_immutability({
      mode: policy.mode,
    });
    if (!probe.versioning_enabled) throw new ObjectLockVersioningDisabledError(this._bucket);
    if (!probe.object_lock_enabled) throw new ObjectLockUnsupportedError(this._bucket);
    if (!probe.mode_supported)
      throw new ObjectLockModeRejectedError(this._bucket, policy.mode ?? 'UNKNOWN');
  }
}

/** Builds the CopySource value for same-bucket copy (key segments URI-encoded). */
function build_s3_copy_source(bucket: string, key: string): string {
  const encoded_key = key.split('/').map(encodeURIComponent).join('/');
  return `${bucket}/${encoded_key}`;
}

function is_backend_mode_rejection(err: unknown, mode?: string): boolean {
  if (!mode) return false;
  if (!(err instanceof S3ServiceException)) return false;
  const error_text = `${err.name} ${err.message}`.toLowerCase();
  return (
    error_text.includes('object lock') ||
    error_text.includes('invalidrequest') ||
    error_text.includes('invalidargument')
  );
}
