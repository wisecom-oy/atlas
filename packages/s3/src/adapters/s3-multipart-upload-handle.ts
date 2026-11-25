import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { StorageError } from '@wisecom/atlas-types';
import type { CompletedMultipartUpload, MultipartUploadHandle } from '@wisecom/atlas-types';

/** S3 multipart upload session; completes or aborts via {@link MultipartUploadHandle}. */
export class S3MultipartUploadHandle implements MultipartUploadHandle {
  constructor(
    private readonly _client: S3Client,
    private readonly _bucket: string,
    private readonly _key: string,
    private readonly _upload_id: string,
  ) {}

  /** Uploads one part and returns its ETag for {@link MultipartUploadHandle.complete}. */
  async upload_part(part_number: number, data: Buffer): Promise<string> {
    const response = await this._client.send(
      new UploadPartCommand({
        Bucket: this._bucket,
        Key: this._key,
        UploadId: this._upload_id,
        PartNumber: part_number,
        Body: data,
      }),
    );
    if (!response.ETag) throw new StorageError(`Missing ETag for multipart part ${part_number}`);
    return response.ETag;
  }

  /**
   * Finalises the upload with parts sorted by ascending part number.
   *
   * The `VersionId` is only in the response of a versioned bucket, and it is the one moment the
   * new version is named without a listing.
   */
  async complete(
    parts: Array<{ ETag: string; PartNumber: number }>,
  ): Promise<CompletedMultipartUpload> {
    const response = await this._client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this._bucket,
        Key: this._key,
        UploadId: this._upload_id,
        MultipartUpload: {
          Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber),
        },
      }),
    );
    return response.VersionId ? { version_id: response.VersionId } : {};
  }

  /** Aborts the session and deletes staged parts (best-effort). */
  async abort(): Promise<void> {
    await this._client.send(
      new AbortMultipartUploadCommand({
        Bucket: this._bucket,
        Key: this._key,
        UploadId: this._upload_id,
      }),
    );
  }
}
