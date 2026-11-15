import { ConfigError } from '@wisecom/atlas-types';
import type { ResolvedBucket } from '@wisecom/atlas-types';
import { is_same_tenant, is_valid_bucket_name, type BucketSelection } from '@wisecom/atlas-core';

/** Bucket name convention: atlas-{tenant_id}. */
export function tenant_bucket_name(tenant_id: string): string {
  return `atlas-${tenant_id}`;
}

/**
 * The bucket a tenant's data lives in: the configured override bound to that tenant, else the
 * derived `atlas-<tenant_id>`.
 *
 * The run's own tenant takes the run's binding. Any other tenant is refused when the run's
 * override is exclusive (`ATLAS_S3_BUCKET`, the SDK's `s3Bucket`); otherwise it takes the bucket
 * its own profiles name, and is refused when they disagree.
 *
 * @throws ConfigError when the tenant may not be opened, or its profiles name different buckets.
 */
export function resolve_tenant_bucket(
  selection: BucketSelection | undefined,
  tenant_id: string,
): ResolvedBucket {
  if (selection === undefined) return derived(tenant_id);
  const { run } = selection;
  if (is_same_tenant(run.tenant_id, tenant_id)) return named(tenant_id, run.bucket);
  if (run.exclusive) {
    throw new ConfigError(
      `${run.set_by} names bucket "${run.bucket}" for tenant ${run.tenant_id} only, so this run ` +
        `refuses to open tenant ${tenant_id}. Run commands for other tenants without the override.`,
    );
  }
  const names = new Set(
    selection.profiles
      .filter((binding) => is_same_tenant(binding.tenant_id, tenant_id))
      .map((binding) => binding.bucket ?? tenant_bucket_name(tenant_id)),
  );
  if (names.size > 1) {
    throw new ConfigError(
      `Tenant profiles name different buckets for tenant ${tenant_id}: ` +
        `${[...names].sort().join(', ')}. Select the intended profile with --profile.`,
    );
  }
  return named(tenant_id, [...names][0]);
}

function named(tenant_id: string, bucket: string | undefined): ResolvedBucket {
  if (bucket === undefined || bucket === tenant_bucket_name(tenant_id)) return derived(tenant_id);
  return { name: bucket, configured: true };
}

function derived(tenant_id: string): ResolvedBucket {
  return { name: tenant_bucket_name(tenant_id), configured: false };
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
  if (is_valid_bucket_name(bucket)) return undefined;
  return new ConfigError(
    `"${bucket}" is not a valid S3 bucket name: it must be 3 to 63 lowercase letters, digits, ` +
      'dots or dashes. Atlas names the bucket after the tenant ID, so store the tenant ID in ' +
      'lowercase, or use the tenant GUID when the domain is too long.',
    cause === undefined ? undefined : { cause },
  );
}
