import { create_container_from_config } from '@/container';
import type { AtlasConfig } from '@atlas/core';
import type {
  AtlasInstance,
  AtlasInstanceConfig,
  StorageCheckUseCase,
  StatsUseCase,
  ReplicationUseCase,
  UserIdentityResolver,
  IdentityRegistryRepository,
} from '@atlas/types';
import {
  STORAGE_CHECK_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  REPLICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  IDENTITY_REGISTRY_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import type { TenantContextFactory } from '@atlas/types';
import { create_outlook_api } from '@/outlook-api.factory';
import { create_onedrive_api } from '@/onedrive-api.factory';
import { create_sharepoint_api } from '@/sharepoint-api.factory';

/** Creates a tenant-bound Atlas SDK instance from explicit configuration values. */
export function createAtlasInstance(config: AtlasInstanceConfig): AtlasInstance {
  const atlas_config = normalizeConfig(config);
  const container = create_container_from_config(atlas_config);
  const tenant_id = atlas_config.tenant_id;

  const storage_check = container.get<StorageCheckUseCase>(STORAGE_CHECK_USE_CASE_TOKEN);
  const stats = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);
  const replication = container.get<ReplicationUseCase>(REPLICATION_USE_CASE_TOKEN);
  const identity_resolver = container.get<UserIdentityResolver>(USER_IDENTITY_RESOLVER_TOKEN);
  const identity_registry = container.get<IdentityRegistryRepository>(
    IDENTITY_REGISTRY_REPOSITORY_TOKEN,
  );
  const tenant_factory = container.get<TenantContextFactory>(TENANT_CONTEXT_FACTORY_TOKEN);

  return {
    outlook: create_outlook_api(tenant_id, container),
    onedrive: create_onedrive_api(tenant_id, container),
    sharepoint: create_sharepoint_api(tenant_id, container),

    async checkStorage(request) {
      return await storage_check.check_storage(tenant_id, request);
    },
    async getBucketStats() {
      return await stats.get_bucket_stats(tenant_id);
    },
    async resolveUser(email) {
      return await identity_resolver.resolve_user(tenant_id, email);
    },
    async listUsers() {
      const ctx = await tenant_factory.create(tenant_id);
      try {
        return await identity_registry.load(ctx);
      } finally {
        ctx.destroy();
      }
    },
    async replicateSnapshot(snapshot_id, targets) {
      return await replication.replicate_snapshot(tenant_id, snapshot_id, targets);
    },
    async replicateMailbox(mailbox_id, targets) {
      return await replication.replicate_mailbox(tenant_id, mailbox_id, targets);
    },
    async rehydrateSnapshot(snapshot_id, source) {
      return await replication.rehydrate_snapshot(tenant_id, snapshot_id, source);
    },
    async rehydrateMailbox(mailbox_id, source) {
      return await replication.rehydrate_mailbox(tenant_id, mailbox_id, source);
    },
    async rehydrateTenant(source) {
      return await replication.rehydrate_tenant(tenant_id, source);
    },
    async getReplicationStatus(snapshot_id) {
      return await replication.get_replication_status(tenant_id, snapshot_id);
    },
    async getReplicationStatusByMailbox(mailbox_id) {
      return await replication.get_replication_status_by_owner(tenant_id, mailbox_id);
    },
  };
}

function normalizeConfig(config: AtlasInstanceConfig): AtlasConfig {
  assertRequiredField(config.tenantId, 'tenantId');
  assertRequiredField(config.clientId, 'clientId');
  assertRequiredField(config.clientSecret, 'clientSecret');
  assertRequiredField(config.s3Endpoint, 's3Endpoint');
  assertRequiredField(config.s3AccessKey, 's3AccessKey');
  assertRequiredField(config.s3SecretKey, 's3SecretKey');
  assertRequiredField(config.encryptionPassphrase, 'encryptionPassphrase');

  return {
    tenant_id: config.tenantId,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    s3_endpoint: config.s3Endpoint,
    s3_access_key: config.s3AccessKey,
    s3_secret_key: config.s3SecretKey,
    s3_region: config.s3Region || 'us-east-1',
    encryption_passphrase: config.encryptionPassphrase,
  };
}

function assertRequiredField(value: string, field_name: keyof AtlasInstanceConfig): void {
  if (!value) {
    throw new Error(`Missing required Atlas instance config field: ${field_name}`);
  }
}
