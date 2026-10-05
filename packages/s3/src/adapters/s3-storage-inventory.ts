import {
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type {
  StorageIncompleteUpload,
  StorageInventory,
  StorageListedObject,
  StorageListingRequest,
  StorageObjectPage,
  StorageUploadCursor,
  StorageUploadPage,
} from '@wisecom/atlas-types';
import { is_access_denied } from '@/adapters/s3-error-classifier';

/**
 * Lists one tenant bucket with object sizes, for measuring what it physically holds.
 *
 * Read-only: it never creates the bucket and never reads key material, so it needs only the list
 * permissions (`s3:ListBucket`, `s3:ListBucketVersions`, `s3:ListBucketMultipartUploads`,
 * `s3:ListMultipartUploadParts`).
 */
export class S3StorageInventory implements StorageInventory {
  constructor(
    private readonly _client: S3Client,
    private readonly _bucket: string,
  ) {}

  /**
   * Lists versions, or live objects in `current` mode. A refused first version page falls back to
   * live objects and says so through `mode`; a refusal after the first page cannot switch without
   * counting the prefix twice, so it propagates.
   */
  async list_object_page(request: StorageListingRequest): Promise<StorageObjectPage> {
    if (request.mode === 'current') return this.list_current_page(request, 1);
    try {
      return await this.list_versions_page(request);
    } catch (err) {
      if (!is_access_denied(err) || request.cursor) throw err;
      return this.list_current_page({ ...request, mode: 'current' }, 2);
    }
  }

  /** One page of incomplete uploads, each sized by listing its parts. */
  async list_incomplete_upload_page(cursor?: StorageUploadCursor): Promise<StorageUploadPage> {
    let response;
    try {
      response = await this._client.send(
        new ListMultipartUploadsCommand({
          Bucket: this._bucket,
          KeyMarker: cursor?.key_marker,
          UploadIdMarker: cursor?.upload_id_marker,
        }),
      );
    } catch (err) {
      if (is_access_denied(err)) return { visible: false, uploads: [], requests: 1 };
      throw err;
    }

    let requests = 1;
    const uploads: StorageIncompleteUpload[] = [];
    for (const upload of response.Uploads ?? []) {
      if (!upload.Key || !upload.UploadId) continue;
      const sized = await this.sum_upload_parts(upload.Key, upload.UploadId);
      requests += sized.requests;
      // Completed or aborted between the two listings: it no longer holds parts.
      if (sized.bytes !== undefined) uploads.push({ key: upload.Key, bytes: sized.bytes });
    }

    const next = response.IsTruncated
      ? require_marker(
          { key_marker: response.NextKeyMarker, upload_id_marker: response.NextUploadIdMarker },
          response.NextKeyMarker,
        )
      : undefined;
    return { visible: true, uploads, requests, ...(next ? { next } : {}) };
  }

  private async list_versions_page(request: StorageListingRequest): Promise<StorageObjectPage> {
    const response = await this._client.send(
      new ListObjectVersionsCommand({
        Bucket: this._bucket,
        Prefix: request.prefix,
        Delimiter: request.delimiter,
        KeyMarker: request.cursor?.key_marker,
        VersionIdMarker: request.cursor?.version_id_marker,
      }),
    );
    const objects: StorageListedObject[] = [];
    for (const version of response.Versions ?? []) {
      if (!version.Key) continue;
      objects.push({
        key: version.Key,
        size: version.Size ?? 0,
        is_latest: version.IsLatest === true,
        is_delete_marker: false,
      });
    }
    for (const marker of response.DeleteMarkers ?? []) {
      if (!marker.Key) continue;
      objects.push({
        key: marker.Key,
        size: 0,
        is_latest: marker.IsLatest === true,
        is_delete_marker: true,
      });
    }
    const next = response.IsTruncated
      ? require_marker(
          { key_marker: response.NextKeyMarker, version_id_marker: response.NextVersionIdMarker },
          response.NextKeyMarker,
        )
      : undefined;
    return {
      mode: 'versions',
      objects,
      common_prefixes: prefixes_of(response.CommonPrefixes),
      requests: 1,
      ...(next ? { next } : {}),
    };
  }

  private async list_current_page(
    request: StorageListingRequest,
    requests: number,
  ): Promise<StorageObjectPage> {
    const response = await this._client.send(
      new ListObjectsV2Command({
        Bucket: this._bucket,
        Prefix: request.prefix,
        Delimiter: request.delimiter,
        ContinuationToken: request.cursor?.continuation_token,
      }),
    );
    const objects: StorageListedObject[] = [];
    for (const object of response.Contents ?? []) {
      if (!object.Key) continue;
      objects.push({
        key: object.Key,
        size: object.Size ?? 0,
        is_latest: true,
        is_delete_marker: false,
      });
    }
    const next = response.IsTruncated
      ? require_marker(
          { continuation_token: response.NextContinuationToken },
          response.NextContinuationToken,
        )
      : undefined;
    return {
      mode: 'current',
      objects,
      common_prefixes: prefixes_of(response.CommonPrefixes),
      requests,
      ...(next ? { next } : {}),
    };
  }

  /** Sums the sizes of an upload's parts, or `undefined` when the upload is gone. */
  private async sum_upload_parts(
    key: string,
    upload_id: string,
  ): Promise<{ bytes: number | undefined; requests: number }> {
    let bytes = 0;
    let requests = 0;
    let marker: string | undefined;
    do {
      requests++;
      let response;
      try {
        response = await this._client.send(
          new ListPartsCommand({
            Bucket: this._bucket,
            Key: key,
            UploadId: upload_id,
            PartNumberMarker: marker,
          }),
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'NoSuchUpload')
          return { bytes: undefined, requests };
        throw err;
      }
      for (const part of response.Parts ?? []) bytes += part.Size ?? 0;
      marker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
    } while (marker);
    return { bytes, requests };
  }
}

function prefixes_of(common: readonly { Prefix?: string | undefined }[] | undefined): string[] {
  return (common ?? []).flatMap((entry) => (entry.Prefix ? [entry.Prefix] : []));
}

/**
 * A truncated page without a marker to continue from would list the same page forever. Some
 * backends omit the marker on a non-truncated page, which is fine; on a truncated one it is a
 * backend fault worth failing on.
 */
function require_marker<T>(cursor: T, marker: string | undefined): T {
  if (!marker) throw new Error('Storage listing was truncated without a marker to continue from');
  return cursor;
}
