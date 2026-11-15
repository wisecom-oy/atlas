import { ConfigError } from '@wisecom/atlas-types';
import type { StoredConfig, TenantProfile } from '@/utils/tenant-profiles';

/** Environment variable that replaces the run's derived bucket name. */
export const BUCKET_ENV_VAR = 'ATLAS_S3_BUCKET';

/** S3 bucket naming: 3 to 63 lowercase letters, digits, dots and dashes, alphanumeric at both ends. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** One tenant and the bucket configured for it. An undefined bucket means `atlas-<tenant_id>`. */
export interface BucketBinding {
  readonly tenant_id: string;
  readonly bucket?: string | undefined;
}

/** The run's own tenant and bucket, with the setting that named it. */
export interface RunBucketBinding extends BucketBinding {
  /**
   * True when the bucket came from `ATLAS_S3_BUCKET` or the SDK's `s3Bucket`: those describe one
   * run, so opening any other tenant in it is refused rather than resolved.
   */
  readonly exclusive: boolean;
  /** Names the setting in error messages, e.g. `ATLAS_S3_BUCKET` or `profile "prod"`. */
  readonly set_by: string;
}

/**
 * Bucket names that replace the derived `atlas-<tenant_id>`, each bound to the tenant it was
 * configured for, so one tenant's bucket can never be opened as another's.
 */
export interface BucketSelection {
  readonly run: RunBucketBinding;
  /** Every profile's tenant and bucket, consulted for tenants other than the run's. */
  readonly profiles: readonly BucketBinding[];
}

/** What {@link build_bucket_selection} combines. */
export interface BucketSelectionInput {
  readonly run_tenant_id: string;
  readonly profile_name: string;
  readonly selected?: Partial<TenantProfile> | undefined;
  readonly env_bucket?: string | undefined;
  readonly profiles: readonly Partial<TenantProfile>[];
}

/** Whether S3 accepts `bucket` as a bucket name. */
export function is_valid_bucket_name(bucket: string): boolean {
  return BUCKET_NAME_RE.test(bucket) && !bucket.includes('..');
}

/** Compares tenant ids the way Entra does: case-insensitively. */
export function is_same_tenant(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The `ATLAS_S3_BUCKET` value, or undefined when it is unset or empty. */
export function read_env_bucket(): string | undefined {
  return process.env[BUCKET_ENV_VAR] || undefined;
}

/**
 * Refuses a top-level `bucket` in the config file or the store. It would apply to every profile,
 * and one bucket name shared by several tenants is exactly what the per-tenant binding prevents.
 */
export function assert_no_shared_bucket(source: StoredConfig, label: string): void {
  const keys = Object.keys(source);
  if (!keys.includes('bucket') && !keys.includes('s3_bucket')) return;
  throw new ConfigError(
    `${label} sets a top-level bucket, which would apply to every tenant profile. A bucket ` +
      'belongs to one tenant: set it on the profile with "atlas tenants add <name> --bucket ' +
      `<bucket> --replace", or for one run with ${BUCKET_ENV_VAR}.`,
  );
}

/** Throws a ConfigError naming `set_by` when `bucket` is not a valid S3 bucket name. */
export function assert_valid_bucket_name(bucket: string, set_by: string): void {
  if (is_valid_bucket_name(bucket)) return;
  throw new ConfigError(
    `${set_by} names "${bucket}", which is not a valid S3 bucket name: it must be 3 to 63 ` +
      'lowercase letters, digits, dots or dashes, starting and ending with a letter or digit.',
  );
}

/**
 * Binds the configured bucket names to their tenants, or returns undefined when nothing
 * overrides the derived name, so a run without an override is configured exactly as before.
 *
 * `ATLAS_S3_BUCKET` wins over the selected profile's `bucket`. A profile's bucket belongs to that
 * profile's tenant, so when `ATLAS_TENANT_ID` points the run at another tenant it does not apply.
 */
export function build_bucket_selection(input: BucketSelectionInput): BucketSelection | undefined {
  const profiles = input.profiles.flatMap(to_binding);
  if (input.env_bucket === undefined && !profiles.some((b) => b.bucket !== undefined)) {
    return undefined;
  }
  const run = build_run_binding(input);
  if (run.bucket !== undefined) assert_valid_bucket_name(run.bucket, run.set_by);
  return { run, profiles };
}

function build_run_binding(input: BucketSelectionInput): RunBucketBinding {
  const { run_tenant_id: tenant_id, env_bucket } = input;
  if (env_bucket !== undefined) {
    return { tenant_id, bucket: env_bucket, exclusive: true, set_by: BUCKET_ENV_VAR };
  }
  const selected = input.selected;
  const owns_run_tenant =
    selected?.tenant_id !== undefined && is_same_tenant(selected.tenant_id, tenant_id);
  return {
    tenant_id,
    bucket: owns_run_tenant ? selected.bucket : undefined,
    exclusive: false,
    set_by: `tenant profile "${input.profile_name}"`,
  };
}

function to_binding(profile: Partial<TenantProfile>): BucketBinding[] {
  if (profile.tenant_id === undefined) return [];
  return [{ tenant_id: profile.tenant_id, bucket: profile.bucket }];
}
