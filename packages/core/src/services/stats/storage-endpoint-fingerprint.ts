import { createHash } from 'node:crypto';

/**
 * A stable id for the S3 endpoint, region and bucket a measurement lists.
 *
 * A continuation token is caller-visible, so it carries this hash and never the endpoint itself.
 * Two endpoints never share a fingerprint in practice, which is what stops a token issued against
 * the primary from resuming a measurement of a replica and summing two buckets as one. The bucket
 * is part of it because a copy under another name can sit on the same endpoint (issue #768).
 */
export function storage_endpoint_fingerprint(
  endpoint: string,
  region: string,
  bucket: string,
): string {
  return createHash('sha256').update(`${endpoint}|${region}|${bucket}`).digest('hex').slice(0, 16);
}
