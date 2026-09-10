import type { StorageTarget, StorageTargetFactory } from '@wisecom/atlas-types';
import type { AtlasConfig } from '@/utils/config';

/** Opens the primary bucket as a storage target, which every replication service needs. */
export function create_primary_target(
  factory: StorageTargetFactory,
  config: AtlasConfig,
): StorageTarget {
  return factory({
    s3Endpoint: config.s3_endpoint,
    s3AccessKey: config.s3_access_key,
    s3SecretKey: config.s3_secret_key,
    s3Region: config.s3_region,
    encryptionPassphrase: config.encryption_passphrase,
  });
}
