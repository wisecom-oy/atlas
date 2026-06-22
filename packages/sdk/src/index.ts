export * from '@wisecom/atlas-types';
export type { StorageTargetSdkConfig } from '@wisecom/atlas-s3';
export { createAtlasInstance } from './atlas-instance.adapter';
export { create_storage_target as createStorageTarget } from '@wisecom/atlas-s3';
export { create_container, create_container_from_config } from './container';
