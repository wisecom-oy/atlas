import type { Container } from 'inversify';
import type {
  OutlookApi,
  BackupUseCase,
  VerificationUseCase,
  RestoreUseCase,
  CatalogUseCase,
  DeletionUseCase,
  SaveUseCase,
  StatsUseCase,
  StatusUseCase,
  MailboxDiscoveryService,
} from '@wisecom/atlas-types';
import {
  BACKUP_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  CATALOG_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  STATUS_USE_CASE_TOKEN,
  MAILBOX_DISCOVERY_TOKEN,
} from '@wisecom/atlas-types';
import { run_with_cost_tracking } from '@wisecom/atlas-core/services/shared/graph-request-context';

/** Builds the OutlookApi sub-namespace from the DI container. */
export function create_outlook_api(tenant_id: string, container: Container): OutlookApi {
  const backup = container.get<BackupUseCase>(BACKUP_USE_CASE_TOKEN);
  const verification = container.get<VerificationUseCase>(VERIFICATION_USE_CASE_TOKEN);
  const restore = container.get<RestoreUseCase>(RESTORE_USE_CASE_TOKEN);
  const catalog = container.get<CatalogUseCase>(CATALOG_USE_CASE_TOKEN);
  const deletion = container.get<DeletionUseCase>(DELETION_USE_CASE_TOKEN);
  const save = container.get<SaveUseCase>(SAVE_USE_CASE_TOKEN);
  const stats = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);
  const status = container.get<StatusUseCase>(STATUS_USE_CASE_TOKEN);
  const discovery = container.get<MailboxDiscoveryService>(MAILBOX_DISCOVERY_TOKEN);

  return {
    async backup(mailbox_id, options) {
      const [result, cost_result] = await run_with_cost_tracking(() =>
        backup.sync_mailbox(tenant_id, mailbox_id, options),
      );
      return { ...result, graph_cost: cost_result };
    },
    async verify(snapshot_id) {
      return await verification.verify_snapshot_integrity(tenant_id, snapshot_id);
    },
    async restore(snapshot_id, options) {
      const [result, cost_result] = await run_with_cost_tracking(() =>
        restore.restore_snapshot(tenant_id, snapshot_id, options),
      );
      return { ...result, graph_cost: cost_result };
    },
    async restoreMailbox(mailbox_id, options) {
      const [result, cost_result] = await run_with_cost_tracking(() =>
        restore.restore_mailbox(tenant_id, mailbox_id, options),
      );
      return { ...result, graph_cost: cost_result };
    },
    async save(snapshot_id, options) {
      return await save.save_snapshot(tenant_id, snapshot_id, options);
    },
    async saveMailbox(mailbox_id, options) {
      return await save.save_mailbox(tenant_id, mailbox_id, options);
    },
    async listMailboxes() {
      return await catalog.list_mailboxes(tenant_id);
    },
    async listSnapshots(mailbox_id) {
      return await catalog.list_snapshots(tenant_id, mailbox_id);
    },
    async getSnapshotDetail(snapshot_id) {
      return await catalog.get_snapshot_detail(tenant_id, snapshot_id);
    },
    async readMessage(snapshot_id, message_ref) {
      return await catalog.read_message(tenant_id, snapshot_id, message_ref);
    },
    async deleteMailboxData(mailbox_id) {
      return await deletion.delete_mailbox_data(tenant_id, mailbox_id);
    },
    async deleteSnapshot(snapshot_id) {
      return await deletion.delete_snapshot(tenant_id, snapshot_id);
    },
    async purgeTenantData() {
      return await deletion.purge_tenant(tenant_id);
    },
    async getMailboxStats(mailbox_id) {
      return await stats.get_mailbox_stats(tenant_id, mailbox_id);
    },
    async checkMailboxStatus(mailbox_id) {
      const [result, cost_result] = await run_with_cost_tracking(() =>
        status.check_mailbox_status(tenant_id, mailbox_id),
      );
      return { ...result, graph_cost: cost_result };
    },
    async listAvailableMailboxes(options) {
      return await discovery.list_tenant_mailboxes(tenant_id, options);
    },
  };
}
