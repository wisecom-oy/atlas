import type { S3Config, StoredConfig } from '@wisecom/atlas-core';
import {
  assert_no_shared_bucket,
  build_bucket_selection,
  find_profile,
  logger,
  profile_names,
  read_env_bucket,
  read_env_overrides,
} from '@wisecom/atlas-core';
import { bucket_exists, create_s3_client, resolve_tenant_bucket } from '@wisecom/atlas-s3';
import type { ResolvedBucket } from '@wisecom/atlas-types';

/** A profile's tenant and the bucket a run with that profile would use. */
export interface ProfileBucket {
  readonly tenant_id: string;
  readonly bucket: ResolvedBucket;
}

/** Where {@link resolve_profile_bucket} reads profiles from, and whether env applies. */
export interface ProfileBucketSources {
  readonly file: StoredConfig;
  readonly secure: StoredConfig;
  /** True for the selected profile only: ATLAS_* variables describe that profile alone. */
  readonly apply_env: boolean;
}

/**
 * The bucket a run with profile `name` would use, by the same rules as `load_config`. Undefined
 * when no tenant ID is known, since the derived name needs one.
 */
export function resolve_profile_bucket(
  name: string,
  sources: ProfileBucketSources,
): ProfileBucket | undefined {
  const { file, secure, apply_env } = sources;
  assert_no_shared_bucket(file, 'atlas.config.json');
  assert_no_shared_bucket(secure, 'The encrypted config store');
  const profile = find_profile(name, file, secure);
  const tenant_id = (apply_env ? read_env_overrides().tenant_id : undefined) ?? profile?.tenant_id;
  if (tenant_id === undefined) return undefined;
  const selection = build_bucket_selection({
    run_tenant_id: tenant_id,
    profile_name: name,
    selected: profile,
    env_bucket: apply_env ? read_env_bucket() : undefined,
    profiles: profile_names(file, secure).map((n) => find_profile(n, file, secure) ?? {}),
  });
  return { tenant_id, bucket: resolve_tenant_bucket(selection, tenant_id) };
}

/**
 * Sends HeadBucket to the effective bucket and logs the outcome; HeadBucket rather than
 * ListBuckets, because bucket-scoped keys often may not list buckets. A missing derived bucket
 * passes, since the first backup creates it; a missing configured bucket fails, since Atlas never
 * creates one.
 */
export async function probe_bucket(
  config: S3Config,
  bucket: ResolvedBucket,
  label = 'S3',
): Promise<boolean> {
  const origin = bucket.configured ? 'configured' : 'derived from the tenant ID';
  logger.info(`${label}: effective bucket "${bucket.name}" (${origin})`);
  const client = create_s3_client(config);
  try {
    if (await bucket_exists(client, bucket.name)) {
      logger.success(`${label}: bucket reachable and credentials accepted`);
      return true;
    }
    if (bucket.configured) {
      logger.error(
        `${label}: configured bucket "${bucket.name}" does not exist. Atlas never creates a ` +
          'configured bucket: check the name, endpoint and region.',
      );
      return false;
    }
    logger.info(`${label}: bucket does not exist yet; the first backup creates it`);
    return true;
  } catch (err) {
    logger.error(
      `${label} validation of bucket "${bucket.name}" failed: ${(err as Error).message}`,
    );
    return false;
  } finally {
    client.destroy();
  }
}
