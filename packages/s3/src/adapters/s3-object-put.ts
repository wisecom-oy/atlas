import { createHash } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { StorageObjectLockPolicy } from '@wisecom/atlas-types';
import {
  ObjectLockModeRejectedError,
  PreconditionFailedError,
} from '@/adapters/object-lock.errors';
import { is_backend_mode_rejection, is_precondition_failed } from '@/adapters/s3-error-classifier';

/** One `PutObject`, with the optional Object Lock policy and write conditions it carries. */
export interface S3PutRequest {
  readonly key: string;
  readonly data: Buffer;
  readonly metadata?: Record<string, string> | undefined;
  readonly object_lock_policy?: StorageObjectLockPolicy | undefined;
  /** Compare-and-swap: the write succeeds only while the stored object has this ETag. */
  readonly if_match?: string | undefined;
  /** Create-only: the write succeeds only when nothing is stored under the key. */
  readonly if_none_match?: boolean | undefined;
}

/** True when the write carries a condition the backend has to enforce. */
export function is_conditional_put(
  request: Pick<S3PutRequest, 'if_match' | 'if_none_match'>,
): boolean {
  return Boolean(request.if_match) || request.if_none_match === true;
}

/**
 * Sends one `PutObject` with a Content-MD5 header for transport integrity, and names a refused
 * condition or Object Lock mode. Checks nothing first: the caller decides whether the bucket is fit.
 * Resolves to the ETag the backend gave the stored object, when it returned one.
 */
export async function send_put_object(
  client: S3Client,
  bucket: string,
  request: S3PutRequest,
): Promise<string | undefined> {
  const { key, data, metadata, object_lock_policy, if_match, if_none_match } = request;
  const content_md5 = createHash('md5').update(data).digest('base64');
  try {
    const response = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentMD5: content_md5,
        Metadata: metadata,
        ObjectLockMode: object_lock_policy?.mode,
        ObjectLockRetainUntilDate: object_lock_policy?.retain_until
          ? new Date(object_lock_policy.retain_until)
          : undefined,
        ...(if_match ? { IfMatch: if_match } : {}),
        ...(if_none_match ? { IfNoneMatch: '*' } : {}),
      }),
    );
    return response?.ETag;
  } catch (err) {
    if (is_precondition_failed(err)) throw new PreconditionFailedError(key);
    if (is_backend_mode_rejection(err, object_lock_policy?.mode)) {
      throw new ObjectLockModeRejectedError(bucket, object_lock_policy?.mode ?? 'UNKNOWN', err);
    }
    throw err;
  }
}
