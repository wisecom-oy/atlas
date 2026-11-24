/**
 * The two bucket naming rules a provisioning tool needs before Atlas runs: the name Atlas derives
 * for a tenant, and the check an explicit bucket name must pass.
 *
 * They stay separate on purpose. Deriving never validates: a backend with relaxed naming may hold
 * a bucket an older Atlas created from a mixed-case tenant ID, and those backups must stay
 * reachable (issue #598). The check applies to a name an operator supplies, and to a derived name
 * only where a bucket is created or found unreachable.
 *
 * This module imports nothing: the SDK publishes it through `@wisecom/atlas-sdk/contract`, which
 * must bundle for a browser or a Worker (issues #824, #829).
 */

/** S3 bucket naming: 3 to 63 lowercase letters, digits, dots and dashes, alphanumeric at both ends. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** The bucket Atlas uses for a tenant when no override names one: `atlas-<tenant_id>`, case kept. */
export function tenant_bucket_name(tenant_id: string): string {
  return `atlas-${tenant_id}`;
}

/** Whether Atlas accepts `bucket` as an explicit bucket name, which is when S3 would. */
export function is_valid_bucket_name(bucket: string): boolean {
  return BUCKET_NAME_RE.test(bucket) && !bucket.includes('..');
}
