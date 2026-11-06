import { ConfigError } from '@wisecom/atlas-types';

/** S3 bucket naming: 3 to 63 lowercase letters, digits, dots and dashes, alphanumeric at both ends. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Bucket name convention: atlas-{tenant_id}. */
export function tenant_bucket_name(tenant_id: string): string {
  return `atlas-${tenant_id}`;
}

/**
 * Explains why S3 would reject `bucket`, or returns undefined when the name is valid.
 *
 * Only consulted where a bucket is created or found unreachable, never on every derivation: a
 * backend with relaxed naming may already hold a bucket an older Atlas created under a name this
 * rejects, and those backups must stay reachable (issue #598).
 */
export function invalid_bucket_name_error(
  bucket: string,
  cause?: unknown,
): ConfigError | undefined {
  if (BUCKET_NAME_RE.test(bucket) && !bucket.includes('..')) return undefined;
  return new ConfigError(
    `"${bucket}" is not a valid S3 bucket name: it must be 3 to 63 lowercase letters, digits, ` +
      'dots or dashes. Atlas names the bucket after the tenant ID, so store the tenant ID in ' +
      'lowercase, or use the tenant GUID when the domain is too long.',
    cause === undefined ? undefined : { cause },
  );
}
