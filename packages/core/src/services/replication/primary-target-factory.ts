import type { StorageTarget, StorageTargetFactory } from '@wisecom/atlas-types';
import type { AtlasConfig } from '@/utils/config';

/** Opens the primary bucket as a storage target, which every replication service needs. */
export function create_primary_target(
  factory: StorageTargetFactory,
  config: AtlasConfig,
): StorageTarget {
  return factory({
    s3_endpoint: config.s3_endpoint,
    s3_access_key: config.s3_access_key,
    s3_secret_key: config.s3_secret_key,
    s3_region: config.s3_region,
    encryption_passphrase: config.encryption_passphrase,
  });
}
