import { create_container_from_config } from '@/container';
import type { AtlasConfig } from '@atlas/core';
import type {
  AtlasInstance,
  AtlasInstanceConfig,
  BackupUseCase,
  VerificationUseCase,
  RestoreUseCase,
  CatalogUseCase,
  DeletionUseCase,
  StorageCheckUseCase,
  SaveUseCase,
  StatsUseCase,
  StatusUseCase,
  ReplicationUseCase,
} from '@atlas/types';
import {
  BACKUP_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  CATALOG_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  STORAGE_CHECK_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  STATUS_USE_CASE_TOKEN,
  REPLICATION_USE_CASE_TOKEN,
} from '@atlas/types';

/** Creates a tenant-bound Atlas SDK instance from explicit configuration values. */
export function createAtlasInstance(config: AtlasInstanceConfig): AtlasInstance {
  const atlas_config = normalizeConfig(config);
  const container = create_container_from_config(atlas_config);
  const tenant_id = atlas_config.tenant_id;
  const backup_use_case = container.get<BackupUseCase>(BACKUP_USE_CASE_TOKEN);
  const verification_use_case = container.get<VerificationUseCase>(VERIFICATION_USE_CASE_TOKEN);
  const restore_use_case = container.get<RestoreUseCase>(RESTORE_USE_CASE_TOKEN);
  const catalog_use_case = container.get<CatalogUseCase>(CATALOG_USE_CASE_TOKEN);
  const deletion_use_case = container.get<DeletionUseCase>(DELETION_USE_CASE_TOKEN);
  const storage_check_use_case = container.get<StorageCheckUseCase>(STORAGE_CHECK_USE_CASE_TOKEN);
  const save_use_case = container.get<SaveUseCase>(SAVE_USE_CASE_TOKEN);
  const stats_use_case = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);
  const status_use_case = container.get<StatusUseCase>(STATUS_USE_CASE_TOKEN);
  const replication_use_case = container.get<ReplicationUseCase>(REPLICATION_USE_CASE_TOKEN);

  return {
    async backupMailbox(mailbox_id, options) {
      return await backup_use_case.sync_mailbox(tenant_id, mailbox_id, options);
    },
    async verifySnapshot(snapshot_id) {
      return await verification_use_case.verify_snapshot_integrity(tenant_id, snapshot_id);
    },
    async restoreSnapshot(snapshot_id, options) {
      return await restore_use_case.restore_snapshot(tenant_id, snapshot_id, options);
    },
    async restoreMailbox(mailbox_id, options) {
      return await restore_use_case.restore_mailbox(tenant_id, mailbox_id, options);
    },
    async saveSnapshot(snapshot_id, options) {
      return await save_use_case.save_snapshot(tenant_id, snapshot_id, options);
    },
    async saveMailbox(mailbox_id, options) {
      return await save_use_case.save_mailbox(tenant_id, mailbox_id, options);
    },
    async listMailboxes() {
      return await catalog_use_case.list_mailboxes(tenant_id);
    },
    async listSnapshots(mailbox_id) {
      return await catalog_use_case.list_snapshots(tenant_id, mailbox_id);
    },
    async getSnapshotDetail(snapshot_id) {
      return await catalog_use_case.get_snapshot_detail(tenant_id, snapshot_id);
    },
    async readMessage(snapshot_id, message_ref) {
      return await catalog_use_case.read_message(tenant_id, snapshot_id, message_ref);
    },
    async deleteMailboxData(mailbox_id) {
      return await deletion_use_case.delete_mailbox_data(tenant_id, mailbox_id);
    },
    async deleteSnapshot(snapshot_id) {
      return await deletion_use_case.delete_snapshot(tenant_id, snapshot_id);
    },
    async checkStorage(request) {
      return await storage_check_use_case.check_storage(tenant_id, request);
    },
    async getBucketStats() {
      return await stats_use_case.get_bucket_stats(tenant_id);
    },
    async getMailboxStats(mailbox_id) {
      return await stats_use_case.get_mailbox_stats(tenant_id, mailbox_id);
    },
    async checkMailboxStatus(mailbox_id) {
      return await status_use_case.check_mailbox_status(tenant_id, mailbox_id);
    },
    async replicateSnapshot(snapshot_id, targets) {
      return await replication_use_case.replicate_snapshot(tenant_id, snapshot_id, targets);
    },
    async replicateMailbox(mailbox_id, targets) {
      return await replication_use_case.replicate_mailbox(tenant_id, mailbox_id, targets);
    },
    async rehydrateSnapshot(snapshot_id, source) {
      return await replication_use_case.rehydrate_snapshot(tenant_id, snapshot_id, source);
    },
    async rehydrateMailbox(mailbox_id, source) {
      return await replication_use_case.rehydrate_mailbox(tenant_id, mailbox_id, source);
    },
    async rehydrateTenant(source) {
      return await replication_use_case.rehydrate_tenant(tenant_id, source);
    },
    async getReplicationStatus(snapshot_id) {
      return await replication_use_case.get_replication_status(tenant_id, snapshot_id);
    },
    async getReplicationStatusByMailbox(mailbox_id) {
      return await replication_use_case.get_replication_status_by_owner(tenant_id, mailbox_id);
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
