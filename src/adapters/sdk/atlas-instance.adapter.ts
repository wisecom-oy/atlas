import { create_container_from_config } from '@/container';
import type { AtlasConfig } from '@/utils/config';
import type { AtlasInstance, AtlasInstanceConfig } from '@/ports/atlas/use-case.port';
import type { BackupUseCase } from '@/ports/backup/use-case.port';
import type { VerificationUseCase } from '@/ports/verification/use-case.port';
import type { RestoreUseCase } from '@/ports/restore/use-case.port';
import type { CatalogUseCase } from '@/ports/catalog/use-case.port';
import type { DeletionUseCase } from '@/ports/deletion/use-case.port';
import type { StorageCheckUseCase } from '@/ports/storage-check/use-case.port';
import type { SaveUseCase } from '@/ports/save/use-case.port';
import type { StatsUseCase } from '@/ports/stats/use-case.port';
import type { StatusUseCase } from '@/ports/status/use-case.port';
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
} from '@/ports/tokens/use-case.tokens';

/** Creates a tenant-bound Atlas SDK instance from explicit configuration values. */
export function createAtlasInstance(config: AtlasInstanceConfig): AtlasInstance {
  const atlasConfig = normalizeConfig(config);
  const container = create_container_from_config(atlasConfig);
  const tenantId = atlasConfig.tenant_id;
  const backupUseCase = container.get<BackupUseCase>(BACKUP_USE_CASE_TOKEN);
  const verificationUseCase = container.get<VerificationUseCase>(VERIFICATION_USE_CASE_TOKEN);
  const restoreUseCase = container.get<RestoreUseCase>(RESTORE_USE_CASE_TOKEN);
  const catalogUseCase = container.get<CatalogUseCase>(CATALOG_USE_CASE_TOKEN);
  const deletionUseCase = container.get<DeletionUseCase>(DELETION_USE_CASE_TOKEN);
  const storageCheckUseCase = container.get<StorageCheckUseCase>(STORAGE_CHECK_USE_CASE_TOKEN);
  const saveUseCase = container.get<SaveUseCase>(SAVE_USE_CASE_TOKEN);
  const statsUseCase = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);
  const statusUseCase = container.get<StatusUseCase>(STATUS_USE_CASE_TOKEN);

  return {
    async backupMailbox(mailboxId, options) {
      return await backupUseCase.sync_mailbox(tenantId, mailboxId, options);
    },
    async verifySnapshot(snapshotId) {
      return await verificationUseCase.verify_snapshot_integrity(tenantId, snapshotId);
    },
    async restoreSnapshot(snapshotId, options) {
      return await restoreUseCase.restore_snapshot(tenantId, snapshotId, options);
    },
    async restoreMailbox(mailboxId, options) {
      return await restoreUseCase.restore_mailbox(tenantId, mailboxId, options);
    },
    async saveSnapshot(snapshotId, options) {
      return await saveUseCase.save_snapshot(tenantId, snapshotId, options);
    },
    async saveMailbox(mailboxId, options) {
      return await saveUseCase.save_mailbox(tenantId, mailboxId, options);
    },
    async listMailboxes() {
      return await catalogUseCase.list_mailboxes(tenantId);
    },
    async listSnapshots(mailboxId) {
      return await catalogUseCase.list_snapshots(tenantId, mailboxId);
    },
    async getSnapshotDetail(snapshotId) {
      return await catalogUseCase.get_snapshot_detail(tenantId, snapshotId);
    },
    async readMessage(snapshotId, messageRef) {
      return await catalogUseCase.read_message(tenantId, snapshotId, messageRef);
    },
    async deleteMailboxData(mailboxId) {
      return await deletionUseCase.delete_mailbox_data(tenantId, mailboxId);
    },
    async deleteSnapshot(snapshotId) {
      return await deletionUseCase.delete_snapshot(tenantId, snapshotId);
    },
    async checkStorage(request) {
      return await storageCheckUseCase.check_storage(tenantId, request);
    },
    async getBucketStats() {
      return await statsUseCase.get_bucket_stats(tenantId);
    },
    async getMailboxStats(mailboxId) {
      return await statsUseCase.get_mailbox_stats(tenantId, mailboxId);
    },
    async checkMailboxStatus(mailboxId) {
      return await statusUseCase.check_mailbox_status(tenantId, mailboxId);
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

function assertRequiredField(value: string, fieldName: keyof AtlasInstanceConfig): void {
  if (!value) {
    throw new Error(`Missing required Atlas instance config field: ${fieldName}`);
  }
}
