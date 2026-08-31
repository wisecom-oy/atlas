import { type Container } from 'inversify';
import type { S3Config, CryptoConfig } from '@wisecom/atlas-core';
import {
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  DEK_VALIDATION_FN_TOKEN,
  STORAGE_TARGET_FACTORY_TOKEN,
  STORAGE_CHECK_USE_CASE_TOKEN,
  STORAGE_DISPOSER_TOKEN,
  IDENTITY_REGISTRY_REPOSITORY_TOKEN,
} from '@wisecom/atlas-types';
import type { StorageDisposer } from '@wisecom/atlas-types';
import { create_s3_client, S3_CLIENT_TOKEN } from '@/adapters/s3-client.factory';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';
import { S3IdentityRegistryRepository } from '@/adapters/s3-identity-registry-repository.adapter';
import { DefaultTenantContextFactory } from '@/adapters/tenant-context.factory';
import { validate_dek_match } from '@/adapters/dek-validator';
import { create_storage_target } from '@/adapters/storage-target.factory';
import { StorageCheckService } from '@/services/storage-check.service';
import { BucketCache } from '@/adapters/bucket-cache';

export function bind_s3_storage(container: Container, config: S3Config & CryptoConfig): void {
  const s3_client = create_s3_client(config);
  container.bind(S3_CLIENT_TOKEN).toConstantValue(s3_client);
  // One per container, so two instances cannot answer each other's questions
  // about a same-named bucket at a different endpoint (issue #42).
  container.bind(BucketCache).toSelf().inSingletonScope();

  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).to(DefaultTenantContextFactory).inSingletonScope();
  container.bind(MANIFEST_REPOSITORY_TOKEN).to(S3ManifestRepository).inSingletonScope();
  container
    .bind(IDENTITY_REGISTRY_REPOSITORY_TOKEN)
    .to(S3IdentityRegistryRepository)
    .inSingletonScope();
  container.bind(DEK_VALIDATION_FN_TOKEN).toConstantValue(validate_dek_match);
  container.bind(STORAGE_TARGET_FACTORY_TOKEN).toConstantValue(create_storage_target);

  container.bind(StorageCheckService).toSelf();
  container.bind(STORAGE_CHECK_USE_CASE_TOKEN).toService(StorageCheckService);

  // The adapter knows what it holds, so it owns its own teardown; the SDK only
  // resolves the port (issue #42).
  container.bind<StorageDisposer>(STORAGE_DISPOSER_TOKEN).toConstantValue(async () => {
    s3_client.destroy();
    container.get(BucketCache).clear();
  });
}
