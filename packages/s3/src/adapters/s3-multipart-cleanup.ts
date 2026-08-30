import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

/**
 * Aborts every incomplete multipart upload under a prefix, returning the count.
 *
 * An abandoned multipart upload keeps its parts, and the tenant keeps paying
 * storage for bytes no object will ever expose. The listing is paginated on two
 * markers, key and upload id, because one key can carry several stranded
 * uploads.
 */
export async function abort_incomplete_multipart_uploads(
  client: S3Client,
  bucket: string,
  prefix: string,
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
      if (upload.Key && upload.UploadId) {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
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
