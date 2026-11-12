import { run_with_owner_lease_when_writable } from '@wisecom/atlas-core/services/lease/run-with-owner-lease';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { run_cancellable } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { MailboxConnector, OwnerLeasePort } from '@wisecom/atlas-types';
import type { RestoreConnector } from '@wisecom/atlas-types';
import type { Manifest, ManifestEntry } from '@wisecom/atlas-types';
import {
  open_restore_root,
  parse_restore_destination,
} from '@/services/restore/restore-destination';
import {
  build_folder_map,
  group_entries_by_folder,
  count_unique_folders,
} from '@/services/restore/folder-restore-planner';
import { folder_listing_for } from '@/services/restore/recoverable-items-filter';
import {
  refuse_message_ref_in_mailbox_mode,
  resolve_mailbox_entries,
} from '@/services/shared/mailbox-entry-resolver';
import { resolve_snapshot_entries } from '@/services/shared/snapshot-entry-resolver';
import { backfill_missing_folder_ids } from '@/services/restore/restore-execution-orchestrator';
import {
  empty_restore_result,
  restore_message_run,
} from '@/services/restore/single-message-restore-run';
import { execute_restore_loop } from '@/services/restore/restore-loop-executor';
import { NoopTransferProgressReporter } from '@/services/shared/noop-transfer-progress-reporter';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { assert_mailbox_exists } from '@wisecom/atlas-core/services/shared/mailbox-assertions';
import type { RestoreUseCase, RestoreResult, RestoreOptions } from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
  OWNER_LEASE_TOKEN,
} from '@wisecom/atlas-types';
import {
  begin_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';

@injectable()
export class RestoreService implements RestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
    @inject(RESTORE_CONNECTOR_TOKEN) private readonly _restore_connector: RestoreConnector,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Restores messages from a snapshot back to the mailbox via Graph API.
   * Supports full snapshot, single folder, or single message scope.
   */
  async restore_snapshot(
    tenant_id: string,
    snapshot_id: string,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    // Under the run's abort signal, so Ctrl+C also ends a Graph retry or throttle wait (#682),
    // including the destination folder lookups and creates.
    return run_cancellable(
      options,
      () => this.restore_snapshot_entries(tenant_id, snapshot_id, options),
      () => this.finish_interrupted_result(snapshot_id, options),
    );
  }

  /** Restores one snapshot, or the single message `message_ref` names. */
  private async restore_snapshot_entries(
    tenant_id: string,
    snapshot_id: string,
    options: RestoreOptions,
  ): Promise<RestoreResult> {
    // A malformed destination is refused before any storage or Graph call.
    parse_restore_destination(options.destination);
    if (begin_operation_progress(options, 'restore', 'outlook')) {
      return this.finish_empty_result(snapshot_id, options);
    }
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const {
        owner_id: source_mailbox,
        entries,
        manifests,
      } = await resolve_snapshot_entries(
        ctx,
        this._manifests,
        this._connector,
        tenant_id,
        snapshot_id,
        options,
      );
      const scope = {
        workload: 'outlook',
        owner_id: source_mailbox,
        operation: 'restore',
      } as const;
      return await run_with_owner_lease_when_writable(this._leases, ctx, scope, (leased) =>
        this.restore_resolved_snapshot(
          leased,
          tenant_id,
          snapshot_id,
          source_mailbox,
          entries,
          manifests,
          options,
        ),
      );
    } finally {
      ctx.destroy();
    }
  }

  /** Restores a resolved snapshot while holding the source mailbox's lease. */
  private async restore_resolved_snapshot(
    ctx: TenantContext,
    tenant_id: string,
    snapshot_id: string,
    source_mailbox: string,
    entries: ManifestEntry[],
    manifests: readonly Manifest[],
    options: RestoreOptions,
  ): Promise<RestoreResult> {
    const target_mailbox = options.target_mailbox?.toLowerCase() ?? source_mailbox;

    await assert_mailbox_exists(this._connector, tenant_id, target_mailbox);

    if (entries.length === 0) {
      logger.warn('No entries to restore');
      return this.finish_empty_result(snapshot_id, options);
    }

    if (options.message_ref) {
      return restore_message_run({
        ctx,
        connector: this._connector,
        restore_connector: this._restore_connector,
        tenant_id,
        source_mailbox,
        target_mailbox,
        snapshot_id,
        entry: entries[0]!,
        manifests,
        options,
      });
    }

    return this.restore_batch(
      ctx,
      tenant_id,
      source_mailbox,
      target_mailbox,
      snapshot_id,
      entries,
      manifests,
      options,
    );
  }

  /**
   * Restores messages from all snapshots for a mailbox, merging and
   * deduplicating entries. Supports date range filtering and folder filter.
   */
  async restore_mailbox(
    tenant_id: string,
    owner_id: string,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    return run_cancellable(
      options,
      () => this.restore_mailbox_entries(tenant_id, owner_id, options),
      () => this.finish_interrupted_result('mailbox', options),
    );
  }

  /** Restores the merged, filtered entries of every snapshot of a mailbox. */
  private async restore_mailbox_entries(
    tenant_id: string,
    owner_id: string,
    options: RestoreOptions,
  ): Promise<RestoreResult> {
    owner_id = normalize_owner_id(owner_id);
    refuse_message_ref_in_mailbox_mode(options.message_ref);
    parse_restore_destination(options.destination);
    if (begin_operation_progress(options, 'restore', 'outlook')) {
      return this.finish_empty_result('mailbox', options);
    }
    const tenant_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const scope = { workload: 'outlook', owner_id, operation: 'restore' } as const;
      return await run_with_owner_lease_when_writable(this._leases, tenant_ctx, scope, (ctx) =>
        this.restore_leased_mailbox(ctx, tenant_id, owner_id, options),
      );
    } finally {
      tenant_ctx.destroy();
    }
  }

  /** Restores a mailbox's merged entries while holding its lease. */
  private async restore_leased_mailbox(
    ctx: TenantContext,
    tenant_id: string,
    owner_id: string,
    options: RestoreOptions,
  ): Promise<RestoreResult> {
    const target = options.target_mailbox?.toLowerCase() ?? owner_id;

    await assert_mailbox_exists(this._connector, tenant_id, target);

    const { manifests, entries: filtered } = await resolve_mailbox_entries(
      ctx,
      this._manifests,
      this._connector,
      tenant_id,
      owner_id,
      options,
    );
    if (manifests.length === 0) {
      logger.warn('No snapshots found for this mailbox in the given date range');
      return this.finish_empty_result('mailbox', options);
    }

    if (filtered.length === 0) {
      logger.warn('No entries to restore after filtering');
      return this.finish_empty_result('mailbox', options);
    }

    logger.info(`Aggregated ${manifests.length} snapshots -- ${filtered.length} unique messages`);

    return this.restore_batch(
      ctx,
      tenant_id,
      owner_id,
      target,
      'mailbox',
      filtered,
      manifests,
      options,
    );
  }

  /** Restores a batch of messages with dashboard progress. */
  private async restore_batch(
    ctx: TenantContext,
    tenant_id: string,
    source_mailbox: string,
    target_mailbox: string,
    snapshot_id: string,
    entries: ManifestEntry[],
    manifests: readonly Manifest[],
    options: RestoreOptions,
  ): Promise<RestoreResult> {
    const folder_map = await build_folder_map(
      this._connector,
      tenant_id,
      source_mailbox,
      manifests,
      folder_listing_for(entries),
    );
    await backfill_missing_folder_ids(ctx, entries);

    const groups = group_entries_by_folder(entries);
    const root = await open_restore_root(
      this._restore_connector,
      tenant_id,
      target_mailbox,
      options.destination,
    );
    const created_folders = new Map<string, string>();

    logger.info(
      `Restoring ${entries.length} messages across ` +
        `${count_unique_folders(entries)} folders into ${root.folder.display_name}`,
    );

    const folder_summaries = [...groups.entries()].map(([fid, items]) => ({
      name: folder_map.get(fid) ?? fid.slice(0, 12),
      total_items: items.length,
    }));
    const dashboard =
      options.create_progress?.(folder_summaries) ?? new NoopTransferProgressReporter();

    return execute_restore_loop(
      ctx,
      root.connector,
      tenant_id,
      target_mailbox,
      snapshot_id,
      root.folder,
      groups,
      folder_map,
      created_folders,
      dashboard,
      options,
    );
  }

  private finish_empty_result(snapshot_id: string, options: RestoreOptions): RestoreResult {
    const interrupted = finish_operation_progress(options, 'restore', 'outlook', 0, 0);
    return empty_restore_result(snapshot_id, interrupted);
  }

  /** The result of a run cancelled before it could build its own: nothing was restored. */
  private finish_interrupted_result(snapshot_id: string, options: RestoreOptions): RestoreResult {
    finish_operation_progress(options, 'restore', 'outlook', 0, 0, true);
    return empty_restore_result(snapshot_id, true);
  }
}
