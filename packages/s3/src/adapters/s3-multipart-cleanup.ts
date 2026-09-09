import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

/**
 * Aborts incomplete multipart uploads under a prefix that started before `older_than`, returning
 * the count.
 *
 * An abandoned multipart upload keeps its parts, and the tenant keeps paying storage for bytes no
 * object will ever expose. The cutoff is what separates abandoned from live: two backups of the
 * same owner share a staging prefix, and an unfiltered sweep aborts the upload the other one is
 * still streaming into, which fails it with `NoSuchUpload` on its next part (issue #345).
 *
 * The listing is paginated on two markers, key and upload id, because one key can carry several
 * stranded uploads.
 */
export async function abort_incomplete_multipart_uploads(
  client: S3Client,
  bucket: string,
  prefix: string,
  older_than: Date,
): Promise<number> {
  let aborted = 0;
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
      // No `Initiated` means the backend did not report a start time, and an upload that cannot be
      // shown to be abandoned is left alone.
      const started = upload.Initiated;
      if (!upload.Key || !upload.UploadId || !started || started >= older_than) continue;
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: upload.Key,
          UploadId: upload.UploadId,
        }),
      );
      aborted += 1;
    }

    if (!response.IsTruncated) break;
    key_marker = response.NextKeyMarker;
    upload_id_marker = response.NextUploadIdMarker;
  }

  return aborted;
}
