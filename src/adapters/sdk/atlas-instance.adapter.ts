import { create_container_from_config } from '@/container';
import type { AtlasConfig } from '@/utils/config';
import type { AtlasInstance, AtlasInstanceConfig } from '@/ports/atlas/use-case.port';
import { run_with_cost_tracking } from '@/services/shared/graph-request-context';
import type { BackupUseCase } from '@/ports/backup/use-case.port';
import type { VerificationUseCase } from '@/ports/verification/use-case.port';
import type { RestoreUseCase } from '@/ports/restore/use-case.port';
import type { CatalogUseCase } from '@/ports/catalog/use-case.port';
import type { DeletionUseCase } from '@/ports/deletion/use-case.port';
import type { StorageCheckUseCase } from '@/ports/storage-check/use-case.port';
import type { SaveUseCase } from '@/ports/save/use-case.port';
import type { StatsUseCase } from '@/ports/stats/use-case.port';
import type { StatusUseCase } from '@/ports/status/use-case.port';
import type { ReplicationUseCase } from '@/ports/replication/use-case.port';
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
  const replicationUseCase = container.get<ReplicationUseCase>(REPLICATION_USE_CASE_TOKEN);

  return {
    async backupMailbox(mailboxId, options) {
      const [result, graphCost] = await run_with_cost_tracking(() =>
        backupUseCase.sync_mailbox(tenantId, mailboxId, options),
      );
      return { ...result, graph_cost: graphCost };
    },
    async verifySnapshot(snapshotId) {
      return await verificationUseCase.verify_snapshot_integrity(tenantId, snapshotId);
    },
    async restoreSnapshot(snapshotId, options) {
      const [result, graphCost] = await run_with_cost_tracking(() =>
        restoreUseCase.restore_snapshot(tenantId, snapshotId, options),
      );
      return { ...result, graph_cost: graphCost };
    },
    async restoreMailbox(mailboxId, options) {
      const [result, graphCost] = await run_with_cost_tracking(() =>
        restoreUseCase.restore_mailbox(tenantId, mailboxId, options),
      );
      return { ...result, graph_cost: graphCost };
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
      const [result, graphCost] = await run_with_cost_tracking(() =>
        statusUseCase.check_mailbox_status(tenantId, mailboxId),
      );
      return { ...result, graph_cost: graphCost };
    },
    async replicateSnapshot(snapshotId, targets) {
      return await replicationUseCase.replicate_snapshot(tenantId, snapshotId, targets);
    },
    async replicateMailbox(mailboxId, targets) {
      return await replicationUseCase.replicate_mailbox(tenantId, mailboxId, targets);
    },
    async rehydrateSnapshot(snapshotId, source) {
      return await replicationUseCase.rehydrate_snapshot(tenantId, snapshotId, source);
    },
    async rehydrateMailbox(mailboxId, source) {
      return await replicationUseCase.rehydrate_mailbox(tenantId, mailboxId, source);
    },
    async rehydrateTenant(source) {
      return await replicationUseCase.rehydrate_tenant(tenantId, source);
    },
    async getReplicationStatus(snapshotId) {
      return await replicationUseCase.get_replication_status(tenantId, snapshotId);
    },
    async getReplicationStatusByMailbox(mailboxId) {
      return await replicationUseCase.get_replication_status_by_mailbox(tenantId, mailboxId);
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
