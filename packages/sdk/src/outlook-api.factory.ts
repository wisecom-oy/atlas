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
import { adapt_operation_options } from '@/operation-options';
import { camelize, snakeize } from '@wisecom/atlas-types/public/case-convert';
import { build_object_lock_policy } from '@wisecom/atlas-core/services/shared/object-lock-policy';
import type { OutlookBackupOptions } from '@wisecom/atlas-types/ports/atlas/outlook-api.port';
import type { SyncOptions } from '@wisecom/atlas-types/ports/backup/use-case.port';

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
        backup.sync_mailbox(tenant_id, mailbox_id, adapt_backup_options(options)),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async verify(snapshot_id, options) {
      return camelize(
        await verification.verify_snapshot_integrity(
          tenant_id,
          snapshot_id,
          adapt_operation_options(options),
        ),
      );
    },
    async restore(snapshot_id, options) {
      const [result, cost_result] = await run_with_cost_tracking(() =>
        restore.restore_snapshot(tenant_id, snapshot_id, adapt_operation_options(options)),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async restoreMailbox(mailbox_id, options) {
      const [result, cost_result] = await run_with_cost_tracking(() =>
        restore.restore_mailbox(tenant_id, mailbox_id, adapt_operation_options(options)),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async save(snapshot_id, options) {
      return camelize(
        await save.save_snapshot(tenant_id, snapshot_id, adapt_operation_options(options)),
      );
    },
    async saveMailbox(mailbox_id, options) {
      return camelize(
        await save.save_mailbox(tenant_id, mailbox_id, adapt_operation_options(options)),
      );
    },
    async listMailboxes() {
      return camelize(await catalog.list_mailboxes(tenant_id));
    },
    async listSnapshots(mailbox_id) {
      return camelize(await catalog.list_snapshots(tenant_id, mailbox_id));
    },
    async getSnapshotDetail(snapshot_id) {
      return camelize(await catalog.get_snapshot_detail(tenant_id, snapshot_id));
    },
    async readMessage(snapshot_id, message_ref) {
      return camelize(await catalog.read_message(tenant_id, snapshot_id, message_ref));
    },
    async deleteMailboxData(mailbox_id) {
      return camelize(await deletion.delete_mailbox_data(tenant_id, mailbox_id));
    },
    async deleteSnapshot(snapshot_id) {
      return camelize(await deletion.delete_snapshot(tenant_id, snapshot_id));
    },
    async purgeTenantData() {
      return camelize(await deletion.purge_tenant(tenant_id));
    },
    async getMailboxStats(mailbox_id) {
      return camelize(await stats.get_mailbox_stats(tenant_id, mailbox_id));
    },
    async checkMailboxStatus(mailbox_id) {
      const [result, cost_result] = await run_with_cost_tracking(() =>
        status.check_mailbox_status(tenant_id, mailbox_id),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async listAvailableMailboxes(options) {
      return camelize(await discovery.list_tenant_mailboxes(tenant_id, snakeize(options)));
    },
  };
}

/**
 * Adapts backup options, derives the Object Lock policy, and maps `hardStopSignal` to the
 * internal `should_force_stop` hook, the escalation the CLI wires to a second Ctrl+C.
 */
function adapt_backup_options(options?: OutlookBackupOptions): SyncOptions | undefined {
  if (!options) return undefined;
  const { hardStopSignal: hard_stop, ...rest } = options;
  const adapted = derive_object_lock_policy(adapt_operation_options(rest));
  if (!hard_stop) return adapted;
  return { ...adapted, should_force_stop: () => hard_stop.aborted };
}

/**
 * Derives `object_lock_policy` from `object_lock_request` when the caller supplied only the
 * request, so SDK and CLI agree on `retain_until`. A caller-supplied policy is kept as is.
 */
function derive_object_lock_policy(adapted?: SyncOptions): SyncOptions | undefined {
  if (!adapted?.object_lock_request || adapted.object_lock_policy) return adapted;
  return {
    ...adapted,
    object_lock_policy: build_object_lock_policy({
      retention_days: adapted.object_lock_request.retention_days,
      lock_mode: adapted.object_lock_request.mode,
    }),
  };
}
