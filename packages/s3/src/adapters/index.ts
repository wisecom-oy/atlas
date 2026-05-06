export { S3ObjectStorage } from './s3-object-storage.adapter';
export { create_s3_client, S3_CLIENT_TOKEN } from './s3-client.factory';
export { S3ManifestRepository } from './s3-manifest-repository.adapter';
export {
  ensure_bucket_exists,
  reset_bucket_cache,
  probe_bucket_immutability,
} from './s3-bucket-manager';
export { tenant_bucket_name } from './tenant-bucket-name';
export {
  ObjectLockVersioningDisabledError,
  ObjectLockUnsupportedError,
  ObjectLockModeRejectedError,
} from './object-lock.errors';
export { validate_dek_match, DekMismatchError } from './dek-validator';
export { DefaultTenantContextFactory } from './tenant-context.factory';
export { create_storage_target, DefaultStorageTarget } from './storage-target.factory';
export type { StorageTargetSdkConfig } from './storage-target.factory';
export { S3IdentityRegistryRepository } from './s3-identity-registry-repository.adapter';
