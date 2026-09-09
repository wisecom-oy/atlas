import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  type MultipartUpload,
  type S3Client,
} from '@aws-sdk/client-s3';
import { logger } from '@wisecom/atlas-core/utils/logger';

/** What a sweep did, so a caller can report the uploads it deliberately left behind. */
export interface MultipartSweepResult {
  readonly aborted: number;
  /** Uploads the backend reported without a start time, which cannot be shown to be abandoned. */
  readonly skipped_unknown_age: number;
}

/**
 * Aborts incomplete multipart uploads under a prefix that no longer show any activity.
 *
 * An abandoned multipart upload keeps its parts, and the tenant keeps paying storage for bytes no
 * object will ever expose. Deciding which are abandoned is the whole problem: two backups of the
 * same owner share a staging prefix, and an unfiltered sweep aborts the upload the other one is
 * still streaming into, which fails it with `NoSuchUpload` on its next part (issue #345).
 *
 * An upload qualifies only when it started before `older_than` *and* has no part written since
 * then. The start time alone is not enough, because nothing caps one item's transfer at the
 * cutoff: a very large file on a throttled link legitimately runs for hours. The last part written
 * is what says whether anyone is still feeding it, and a live upload writes one every few seconds.
 * The extra `ListParts` costs one request per upload already past the cutoff, which on a healthy
 * bucket is none.
 *
 * The listing is paginated on two markers, key and upload id, because one key can carry several
 * stranded uploads.
 */
export async function abort_incomplete_multipart_uploads(
  client: S3Client,
  bucket: string,
  prefix: string,
  older_than: Date,
): Promise<MultipartSweepResult> {
  let aborted = 0;
  let skipped_unknown_age = 0;
  let key_marker: string | undefined;
  let upload_id_marker: string | undefined;

  for (;;) {
    const response = await client.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: key_marker,
        UploadIdMarker: upload_id_marker,
      }),
    );

    for (const upload of response.Uploads ?? []) {
      const verdict = await classify_upload(client, bucket, upload, older_than);
      if (verdict === 'unknown-age') skipped_unknown_age += 1;
      if (verdict !== 'abandoned') continue;

      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key!,
          UploadId: upload.UploadId!,
        }),
      );
      aborted += 1;
    }

    if (!response.IsTruncated) break;
    key_marker = response.NextKeyMarker;
    upload_id_marker = response.NextUploadIdMarker;
  }

  if (skipped_unknown_age > 0) {
    logger.warn(
      `${skipped_unknown_age} incomplete upload(s) under ${prefix} report no start time, so their ` +
        `age cannot be established and they were left alone. The bucket's lifecycle rule is what ` +
        `collects those.`,
    );
  }

  return { aborted, skipped_unknown_age };
}

/** Whether one listed upload can be shown to be abandoned. */
async function classify_upload(
  client: S3Client,
  bucket: string,
  upload: MultipartUpload,
  older_than: Date,
): Promise<'abandoned' | 'live' | 'unknown-age'> {
  if (!upload.Key || !upload.UploadId) return 'live';
  if (!upload.Initiated) return 'unknown-age';
  if (upload.Initiated >= older_than) return 'live';
  const recent = await has_recent_part(client, bucket, upload.Key, upload.UploadId, older_than);
  return recent ? 'live' : 'abandoned';
}

/** True when any part was written on or after the cutoff, which means someone is still uploading. */
async function has_recent_part(
  client: S3Client,
  bucket: string,
  key: string,
  upload_id: string,
  older_than: Date,
): Promise<boolean> {
  let part_marker: number | undefined;

  for (;;) {
    const response = await client.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: key,
        UploadId: upload_id,
        PartNumberMarker: part_marker === undefined ? undefined : String(part_marker),
      }),
    );

    for (const part of response.Parts ?? []) {
      if (part.LastModified && part.LastModified >= older_than) return true;
    }

    if (!response.IsTruncated || response.NextPartNumberMarker === undefined) return false;
    part_marker = Number(response.NextPartNumberMarker);
  }
}
