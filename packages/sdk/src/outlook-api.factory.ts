import type { Container } from 'inversify';
import type { QuarantineUseCase } from '@wisecom/atlas-types';
import { OUTLOOK_QUARANTINE_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { with_camelized_partial_result } from '@/partial-listing';
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
  UserIdentityResolver,
  ResolvedUserIdentity,
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
  USER_IDENTITY_RESOLVER_TOKEN,
} from '@wisecom/atlas-types';
import { run_with_cost_tracking } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { adapt_operation_options } from '@/operation-options';
import { resolve_owner_identity, resolve_owner_object_id } from '@/owner-resolution';
import { camelize, snakeize } from '@wisecom/atlas-types/public/case-convert';
import { build_object_lock_policy } from '@wisecom/atlas-core/services/shared/object-lock-policy';
import type {
  OutlookBackupOptions,
  OutlookRestoreOptions,
} from '@wisecom/atlas-types/ports/outlook/api.port';
import type { SyncOptions } from '@wisecom/atlas-types/ports/backup/use-case.port';
import type { RestoreOptions } from '@wisecom/atlas-types';
import { split_target_tenant, with_restore_side } from '@/target-tenant';
import {
  refuse_blank_snapshot_message_ref,
  refuse_mailbox_message_ref,
} from '@/outlook-message-ref-guard';

/** Builds the OutlookApi sub-namespace from the DI container. */
export function create_outlook_api(tenant_id: string, container: Container): OutlookApi {
  const quarantine = container.get<QuarantineUseCase>(OUTLOOK_QUARANTINE_USE_CASE_TOKEN);
  const backup = container.get<BackupUseCase>(BACKUP_USE_CASE_TOKEN);
  const verification = container.get<VerificationUseCase>(VERIFICATION_USE_CASE_TOKEN);
  const catalog = container.get<CatalogUseCase>(CATALOG_USE_CASE_TOKEN);
  const deletion = container.get<DeletionUseCase>(DELETION_USE_CASE_TOKEN);
  const save = container.get<SaveUseCase>(SAVE_USE_CASE_TOKEN);
  const stats = container.get<StatsUseCase>(STATS_USE_CASE_TOKEN);
  const status = container.get<StatusUseCase>(STATUS_USE_CASE_TOKEN);
  const discovery = container.get<MailboxDiscoveryService>(MAILBOX_DISCOVERY_TOKEN);
  const identity = container.get<UserIdentityResolver>(USER_IDENTITY_RESOLVER_TOKEN);
  const resolve_object_id = (mailbox: string) =>
    resolve_owner_object_id(identity, tenant_id, mailbox);
  // An email target is resolved to its object id, so the restore is throttled under the same
  // owner id as that mailbox's backups. A cross-tenant target resolves in its own tenant.
  const adapt_restore_options = async (
    options: Omit<OutlookRestoreOptions, 'targetTenant'> | undefined,
    target_identity: UserIdentityResolver,
  ) => {
    const adapted = adapt_operation_options(options);
    // Already cancelled: the service returns its interrupted result without touching Graph.
    if (adapted?.target_mailbox === undefined || adapted.should_interrupt?.() === true) {
      return adapted;
    }
    const target_mailbox = await resolve_owner_object_id(
      target_identity,
      tenant_id,
      adapted.target_mailbox,
    );
    return { ...adapted, target_mailbox };
  };
  const run_restore = <T>(
    options: OutlookRestoreOptions | undefined,
    method: string,
    run: (use_case: RestoreUseCase, adapted: RestoreOptions | undefined) => Promise<T>,
  ): Promise<T> => {
    const [target_tenant, own] = split_target_tenant(options);
    return with_restore_side(container, target_tenant, own?.targetMailbox, method, async (side) =>
      run(
        side.container.get<RestoreUseCase>(RESTORE_USE_CASE_TOKEN),
        await adapt_restore_options(own, side.target_identity),
      ),
    );
  };

  return {
    async backup(mailbox, options) {
      // Resolution is a Graph call too, so it runs inside the tracked scope and counts in graphCost.
      const [result, cost_result] = await run_with_cost_tracking(async () => {
        const resolved = await resolve_owner_identity(identity, tenant_id, mailbox);
        const sync_options = with_resolved_identity(adapt_backup_options(options), resolved);
        return backup.sync_mailbox(tenant_id, resolved?.object_id ?? mailbox, sync_options);
      });
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
      refuse_blank_snapshot_message_ref(options);
      const [result, cost_result] = await run_with_cost_tracking(() =>
        run_restore(options, 'outlook.restore()', (use_case, adapted) =>
          use_case.restore_snapshot(tenant_id, snapshot_id, adapted),
        ),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async restoreMailbox(mailbox, options) {
      refuse_mailbox_message_ref(options);
      const [result, cost_result] = await run_with_cost_tracking(() =>
        run_restore(options, 'outlook.restoreMailbox()', async (use_case, adapted) =>
          use_case.restore_mailbox(tenant_id, await resolve_object_id(mailbox), adapted),
        ),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async save(snapshot_id, options) {
      refuse_blank_snapshot_message_ref(options);
      const [result, cost_result] = await run_with_cost_tracking(() =>
        save.save_snapshot(tenant_id, snapshot_id, adapt_operation_options(options)),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async saveMailbox(mailbox, options) {
      refuse_mailbox_message_ref(options);
      const [result, cost_result] = await run_with_cost_tracking(async () =>
        save.save_mailbox(
          tenant_id,
          await resolve_object_id(mailbox),
          adapt_operation_options(options),
        ),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async listMailboxes() {
      return camelize(await with_camelized_partial_result(() => catalog.list_mailboxes(tenant_id)));
    },
    async listSnapshots(mailbox) {
      const mailbox_id = await resolve_object_id(mailbox);
      return camelize(
        await with_camelized_partial_result(() => catalog.list_snapshots(tenant_id, mailbox_id)),
      );
    },
    async listSnapshotSummaries(mailbox) {
      const mailbox_id = await resolve_object_id(mailbox);
      return camelize(
        await with_camelized_partial_result(() =>
          catalog.list_snapshot_summaries(tenant_id, mailbox_id),
        ),
      );
    },
    async getSnapshotDetail(snapshot_id) {
      return camelize(await catalog.get_snapshot_detail(tenant_id, snapshot_id));
    },
    async readMessage(snapshot_id, message_ref) {
      return camelize(await catalog.read_message(tenant_id, snapshot_id, message_ref));
    },
    async deleteMailboxData(mailbox) {
      const mailbox_id = await resolve_object_id(mailbox);
      return camelize(await deletion.delete_mailbox_data(tenant_id, mailbox_id));
    },
    async deleteSnapshot(snapshot_id) {
      return camelize(await deletion.delete_snapshot(tenant_id, snapshot_id));
    },
    async purgeTenantData() {
      return camelize(await deletion.purge_tenant(tenant_id));
    },
    async getMailboxStats(mailbox) {
      const mailbox_id = await resolve_object_id(mailbox);
      return camelize(await stats.get_mailbox_stats(tenant_id, mailbox_id));
    },
    async checkMailboxStatus(mailbox) {
      const [result, cost_result] = await run_with_cost_tracking(async () =>
        status.check_mailbox_status(tenant_id, await resolve_object_id(mailbox)),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async listAvailableMailboxes(options) {
      return camelize(await discovery.list_tenant_mailboxes(tenant_id, snakeize(options)));
    },
    async quarantine(storage_key) {
      return camelize(await quarantine.quarantine_unreadable_object(tenant_id, storage_key));
    },
  };
}

/** Forwards the resolved address as display metadata unless the caller already supplied one. */
function with_resolved_identity(
  adapted: SyncOptions | undefined,
  resolved: ResolvedUserIdentity | undefined,
): SyncOptions | undefined {
  if (!resolved || adapted?.owner_email !== undefined) return adapted;
  return { ...adapted, owner_email: resolved.email, owner_display_name: resolved.display_name };
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
