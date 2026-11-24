import { ConfigError } from '@wisecom/atlas-types';
import type { ResolvedBucket } from '@wisecom/atlas-types';
import {
  is_same_tenant,
  is_valid_bucket_name,
  tenant_bucket_name,
  type BucketSelection,
} from '@wisecom/atlas-core';

/**
 * The bucket a tenant's data lives in: the configured override bound to that tenant, else the
 * derived `atlas-<tenant_id>`.
 *
 * The run's own tenant takes the run's binding. Any other tenant is refused when the run's
 * override is exclusive (`ATLAS_S3_BUCKET`, the SDK's `s3Bucket`); otherwise it takes the bucket
 * its own profiles name, and is refused when they disagree.
 *
 * @throws ConfigError when the tenant may not be opened, its profiles name different buckets, or
 * the bucket it resolves to is configured for another tenant too.
 */
export function resolve_tenant_bucket(
  selection: BucketSelection | undefined,
  tenant_id: string,
): ResolvedBucket {
  if (selection === undefined) return derived(tenant_id);
  const resolved = resolve_binding(selection, tenant_id);
  if (resolved.configured) assert_bucket_owned_by(selection, resolved.name, tenant_id);
  return resolved;
}

/** Applies the run's binding to its own tenant, and the profiles' bindings to any other. */
function resolve_binding(selection: BucketSelection, tenant_id: string): ResolvedBucket {
  const { run } = selection;
  if (is_same_tenant(run.tenant_id, tenant_id)) return named(tenant_id, run.bucket);
  if (run.exclusive) {
    throw new ConfigError(
      `${run.set_by} names bucket "${run.bucket}" for tenant ${run.tenant_id} only, so this run ` +
        `refuses to open tenant ${tenant_id}. Run commands for other tenants without the override.`,
    );
  }
  return resolve_from_profiles(selection.profiles, tenant_id);
}

/** The bucket a tenant's own profiles agree on, or the derived name when none sets one. */
function resolve_from_profiles(
  profiles: BucketSelection['profiles'],
  tenant_id: string,
): ResolvedBucket {
  const own = profiles.filter((binding) => is_same_tenant(binding.tenant_id, tenant_id));
  const names = new Set(own.map((binding) => binding.bucket ?? tenant_bucket_name(tenant_id)));
  if (names.size > 1) {
    throw new ConfigError(
      `Tenant profiles name different buckets for tenant ${tenant_id}: ` +
        `${[...names].sort().join(', ')}. Select the intended profile with --profile.`,
    );
  }
  return named(tenant_id, own.find((binding) => binding.bucket !== undefined)?.bucket);
}

/**
 * Refuses a configured bucket that a binding of another tenant also names. A bucket holds one
 * tenant's data key: the second tenant would fail to unwrap it, or write its objects beside it.
 */
function assert_bucket_owned_by(
  selection: BucketSelection,
  bucket: string,
  tenant_id: string,
): void {
  const other = [selection.run, ...selection.profiles].find(
    (binding) => binding.bucket === bucket && !is_same_tenant(binding.tenant_id, tenant_id),
  );
  if (other === undefined) return;
  throw new ConfigError(
    `Bucket "${bucket}" is configured for tenant ${tenant_id} and for tenant ${other.tenant_id}. ` +
      "A bucket holds one tenant's data, so name it for one tenant only.",
  );
}

/** An explicitly named bucket stays configured, even when it equals the derived name. */
function named(tenant_id: string, bucket: string | undefined): ResolvedBucket {
  if (bucket === undefined) return derived(tenant_id);
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
