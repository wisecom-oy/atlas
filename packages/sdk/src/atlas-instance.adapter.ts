import { camelize, snakeize } from '@wisecom/atlas-types/public/case-convert';
import { create_container_from_config } from '@/container';
import type { AtlasConfig } from '@wisecom/atlas-core';
import type {
  AtlasInstance,
  AtlasInstanceConfig,
  StorageCheckUseCase,
  StatsUseCase,
  ReplicationUseCase,
  UserIdentityResolver,
  IdentityRegistryRepository,
} from '@wisecom/atlas-types';
import {
  STORAGE_CHECK_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  REPLICATION_USE_CASE_TOKEN,
  USER_IDENTITY_RESOLVER_TOKEN,
  IDENTITY_REGISTRY_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { create_outlook_api } from '@/outlook-api.factory';
import { create_onedrive_api } from '@/onedrive-api.factory';
import { create_sharepoint_api } from '@/sharepoint-api.factory';
import { create_disposer } from '@/instance-disposal';
import { resolve_log_sink, scope_api_logging } from '@/log-scope';

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
  const dispose = create_disposer(container);
  const sink = resolve_log_sink(config.logger);
  const scoped = <T extends object>(api: T): T => scope_api_logging(api, tenant_id, sink);

  // Typed explicitly: assigning to a `const` drops the contextual typing the
  // return position used to give the object literal's method parameters.
  const instance: Omit<AtlasInstance, typeof Symbol.asyncDispose> = scoped({
    outlook: scoped(create_outlook_api(tenant_id, container)),
    onedrive: scoped(create_onedrive_api(tenant_id, container)),
    sharepoint: scoped(create_sharepoint_api(tenant_id, container)),

    async checkStorage(request) {
      return camelize(await storage_check.check_storage(tenant_id, snakeize(request)));
    },
    async getBucketStats() {
      return camelize(await stats.get_bucket_stats(tenant_id));
    },
    async resolveUser(email) {
      return camelize(await identity_resolver.resolve_user(tenant_id, email));
    },
    async listUsers() {
      const ctx = await tenant_factory.create(tenant_id);
      try {
        return camelize(await identity_registry.load(ctx));
      } finally {
        ctx.destroy();
      }
    },
    async replicateSnapshot(snapshot_id, targets) {
      return camelize(await replication.replicate_snapshot(tenant_id, snapshot_id, targets));
    },
    async replicateMailbox(mailbox_id, targets) {
      return camelize(await replication.replicate_mailbox(tenant_id, mailbox_id, targets));
    },
    async rehydrateSnapshot(snapshot_id, source) {
      return camelize(await replication.rehydrate_snapshot(tenant_id, snapshot_id, source));
    },
    async rehydrateMailbox(mailbox_id, source) {
      return camelize(await replication.rehydrate_mailbox(tenant_id, mailbox_id, source));
    },
    async rehydrateTenant(source) {
      return camelize(await replication.rehydrate_tenant(tenant_id, source));
    },
    async getReplicationStatus(snapshot_id) {
      return camelize(await replication.get_replication_status(tenant_id, snapshot_id));
    },
    async getReplicationStatusByOwner(owner_id) {
      return camelize(await replication.get_replication_status_by_owner(tenant_id, owner_id));
    },

    dispose,
  });

  // Attached after `scoped()`, not inside it: that wrapper iterates
  // Object.entries, which skips symbol keys, so an asyncDispose declared inside
  // the literal would be dropped and `await using` would silently do nothing.
  // Pointing at the scoped `dispose` also keeps both entry points identical,
  // including where their teardown warnings are logged.
  return { ...instance, [Symbol.asyncDispose]: instance.dispose };
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
