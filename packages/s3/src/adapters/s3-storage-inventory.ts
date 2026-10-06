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
  StoragePartsPage,
  StorageUploadCursor,
  StorageUploadPage,
} from '@wisecom/atlas-types';
import { is_access_denied } from '@/adapters/s3-error-classifier';

/** Uploads per listing page; AWS allows up to 1,000. */
const UPLOADS_PER_PAGE = 100;

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

  /**
   * One page of incomplete uploads, without sizes: each upload's parts are listed separately, one
   * request at a time, so sizing a page of uploads cannot run past a request allowance.
   */
  async list_incomplete_upload_page(cursor?: StorageUploadCursor): Promise<StorageUploadPage> {
    let response;
    try {
      response = await this._client.send(
        new ListMultipartUploadsCommand({
          Bucket: this._bucket,
          KeyMarker: cursor?.key_marker,
          UploadIdMarker: cursor?.upload_id_marker,
          // Bounds the uploads a continuation token carries while they wait to be sized.
          MaxUploads: UPLOADS_PER_PAGE,
        }),
      );
    } catch (err) {
      if (is_access_denied(err)) return { visible: false, uploads: [] };
      throw err;
    }

    const uploads: StorageIncompleteUpload[] = [];
    for (const upload of response.Uploads ?? []) {
      if (upload.Key && upload.UploadId)
        uploads.push({ key: upload.Key, upload_id: upload.UploadId });
    }
    const next = response.IsTruncated
      ? require_marker(
          { key_marker: response.NextKeyMarker, upload_id_marker: response.NextUploadIdMarker },
          response.NextKeyMarker,
        )
      : undefined;
    return { visible: true, uploads, ...(next ? { next } : {}) };
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

  /** One page of an upload's parts; `gone` once the upload completed or was aborted. */
  async list_upload_parts_page(
    upload: StorageIncompleteUpload,
    part_marker?: string,
  ): Promise<StoragePartsPage> {
    let response;
    try {
      response = await this._client.send(
        new ListPartsCommand({
          Bucket: this._bucket,
          Key: upload.key,
          UploadId: upload.upload_id,
          PartNumberMarker: part_marker,
        }),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'NoSuchUpload') return { status: 'gone', bytes: 0 };
      // Listing uploads and listing their parts are separate permissions.
      if (is_access_denied(err)) return { status: 'denied', bytes: 0 };
      throw err;
    }
    const bytes = (response.Parts ?? []).reduce((sum, part) => sum + (part.Size ?? 0), 0);
    const next = response.IsTruncated
      ? require_marker(response.NextPartNumberMarker, response.NextPartNumberMarker)
      : undefined;
    return { status: 'listed', bytes, ...(next ? { next_part_marker: next } : {}) };
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
