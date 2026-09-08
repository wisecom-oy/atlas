import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  UploadPartCopyCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { StorageObjectLockPolicy } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { build_s3_copy_source } from '@/adapters/s3-error-classifier';

/**
 * Largest source a single `CopyObject` may have.
 *
 * AWS refuses a larger one and requires multipart `UploadPartCopy` instead. The threshold is a
 * constant rather than something read from the backend, so MinIO and AWS take the same branch and
 * the local suites exercise the path AWS would (issue #346).
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
 */
export const MAX_SINGLE_COPY_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Bytes per `UploadPartCopy` range.
 *
 * 1 GiB against the 10,000 part ceiling reaches 10 TiB, comfortably past S3's 5 TiB per-object
 * limit, so no object the upload path can produce runs out of parts.
 */
const COPY_PART_BYTES = 1024 * 1024 * 1024;

export interface ServerSideCopyRequest {
  readonly bucket: string;
  readonly source_key: string;
  readonly dest_key: string;
  readonly metadata?: Record<string, string> | undefined;
  readonly object_lock_policy?: StorageObjectLockPolicy | undefined;
}

/**
 * Copies an object within a bucket, choosing the request the source size allows.
 *
 * A single `CopyObject` is limited to a 5 GB source, which is smaller than the objects the
 * multipart upload path accepts, so promoting a large file used to fail after its bytes were
 * already uploaded. The size comes from a `HeadObject` on the source rather than from the backend's
 * own opinion, so MinIO and AWS take the same branch (issue #346).
 */
export async function copy_object_server_side(
  client: S3Client,
  request: ServerSideCopyRequest,
): Promise<void> {
  const copy_source = build_s3_copy_source(request.bucket, request.source_key);
  const head = await client.send(
    new HeadObjectCommand({ Bucket: request.bucket, Key: request.source_key }),
  );
  const source_bytes = head.ContentLength ?? 0;

  if (source_bytes > MAX_SINGLE_COPY_BYTES) {
    await copy_object_in_parts(client, { ...request, copy_source, source_bytes });
    return;
  }

  await client.send(
    new CopyObjectCommand({
      Bucket: request.bucket,
      Key: request.dest_key,
      CopySource: copy_source,
      Metadata: request.metadata,
      MetadataDirective: request.metadata ? 'REPLACE' : undefined,
      ObjectLockMode: request.object_lock_policy?.mode,
      ObjectLockRetainUntilDate: request.object_lock_policy?.retain_until
        ? new Date(request.object_lock_policy.retain_until)
        : undefined,
    }),
  );
}

interface LargeCopyRequest extends ServerSideCopyRequest {
  readonly copy_source: string;
  readonly source_bytes: number;
}

/**
 * Promotes an object larger than {@link MAX_SINGLE_COPY_BYTES} with ranged `UploadPartCopy`.
 *
 * Server-side throughout: no byte travels through Atlas, so the ciphertext, its checksum and the
 * metadata are the source object's own. Retention and Object Lock are declared on
 * `CreateMultipartUpload`, which is where they take effect for a multipart destination, so the
 * promoted object carries the same policy the single-request copy would have given it.
 */
async function copy_object_in_parts(client: S3Client, request: LargeCopyRequest): Promise<void> {
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: request.bucket,
      Key: request.dest_key,
      Metadata: request.metadata,
      ObjectLockMode: request.object_lock_policy?.mode,
      ObjectLockRetainUntilDate: request.object_lock_policy?.retain_until
        ? new Date(request.object_lock_policy.retain_until)
        : undefined,
    }),
  );
  const upload_id = created.UploadId;
  if (!upload_id) throw new Error('CreateMultipartUpload returned no UploadId for a ranged copy');

  try {
    const parts = await copy_every_part(client, request, upload_id);
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: request.bucket,
        Key: request.dest_key,
        UploadId: upload_id,
        MultipartUpload: { Parts: parts },
      }),
    );
  } catch (err) {
    // An abandoned multipart upload keeps billing for its parts until a lifecycle rule sweeps it.
    await abort_quietly(client, request, upload_id);
    throw err;
  }
}

/** Copies each 1 GiB range in turn, returning the completed part list in order. */
async function copy_every_part(
  client: S3Client,
  request: LargeCopyRequest,
  upload_id: string,
): Promise<{ ETag: string; PartNumber: number }[]> {
  const parts: { ETag: string; PartNumber: number }[] = [];
  let part_number = 1;

  for (let offset = 0; offset < request.source_bytes; offset += COPY_PART_BYTES) {
    const end = Math.min(offset + COPY_PART_BYTES, request.source_bytes) - 1;
    const response = await client.send(
      new UploadPartCopyCommand({
        Bucket: request.bucket,
        Key: request.dest_key,
        UploadId: upload_id,
        CopySource: request.copy_source,
        CopySourceRange: `bytes=${offset}-${end}`,
        PartNumber: part_number,
      }),
    );
    const etag = response.CopyPartResult?.ETag;
    if (!etag) {
      throw new Error(`UploadPartCopy returned no ETag for bytes=${offset}-${end}`);
    }
    parts.push({ ETag: etag, PartNumber: part_number });
    part_number++;
  }

  return parts;
}

async function abort_quietly(
  client: S3Client,
  request: LargeCopyRequest,
  upload_id: string,
): Promise<void> {
  try {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: request.bucket,
        Key: request.dest_key,
        UploadId: upload_id,
      }),
    );
  } catch (err) {
    logger.warn(
      `Could not abort the ranged copy of ${request.dest_key}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Its parts bill until a lifecycle rule sweeps them.`,
    );
  }
}
