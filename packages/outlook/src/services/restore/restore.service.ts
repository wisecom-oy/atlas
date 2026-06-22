import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { TenantContextFactory, TenantContext } from '@atlas/types';
import type { ManifestRepository } from '@atlas/types';
import type { MailboxConnector } from '@atlas/types';
import type { RestoreConnector } from '@atlas/types';
import type { Manifest, ManifestEntry } from '@atlas/types';
import {
  build_folder_map,
  create_restore_root,
  group_entries_by_folder,
  filter_entries_by_folder_name,
  count_unique_folders,
} from '@/services/restore/folder-restore-planner';
import {
  filter_manifests_by_date,
  merge_snapshot_entries,
} from '@/services/restore/manifest-entry-merger';
import {
  restore_single_message,
  backfill_missing_folder_ids,
} from '@/services/restore/restore-execution-orchestrator';
import { execute_restore_loop } from '@/services/restore/restore-loop-executor';
import { RestoreProgressDashboard } from '@/services/restore/restore-progress-dashboard';
import { logger } from '@atlas/core/utils/logger';
import type { RestoreUseCase, RestoreResult, RestoreOptions } from '@atlas/types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
} from '@atlas/types';

@injectable()
export class RestoreService implements RestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
    @inject(RESTORE_CONNECTOR_TOKEN) private readonly _restore_connector: RestoreConnector,
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
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifest = await this.load_manifest(ctx, snapshot_id);
      const source_mailbox = manifest.owner_id;
      const target_mailbox = options.target_mailbox?.toLowerCase() ?? source_mailbox;

      await this.assert_mailbox_exists(tenant_id, target_mailbox);

      const entries = await this.resolve_entries(ctx, manifest, source_mailbox, tenant_id, options);
      if (entries.length === 0) {
        logger.warn('No entries to restore');
        return this.empty_result(snapshot_id);
      }

      if (options.message_ref) {
        return restore_single_message(
          ctx,
          this._connector,
          this._restore_connector,
          tenant_id,
          source_mailbox,
          target_mailbox,
          snapshot_id,
          entries[0]!,
        );
      }

      return this.restore_batch(
        ctx,
        tenant_id,
        source_mailbox,
        target_mailbox,
        snapshot_id,
        entries,
      );
    } finally {
      ctx.destroy();
    }
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
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const target = options.target_mailbox?.toLowerCase() ?? owner_id;

      await this.assert_mailbox_exists(tenant_id, target);

      const manifests = await this.load_mailbox_manifests(ctx, owner_id, options);
      if (manifests.length === 0) {
        logger.warn('No snapshots found for this mailbox in the given date range');
        return this.empty_result('mailbox');
      }

      const entries = merge_snapshot_entries(manifests);

      if (options.folder_name) {
        await backfill_missing_folder_ids(ctx, entries);
      }

      const filtered = await this.apply_entry_filters(entries, owner_id, tenant_id, options);

      if (filtered.length === 0) {
        logger.warn('No entries to restore after filtering');
        return this.empty_result('mailbox');
      }

      logger.info(
        `Aggregated ${chalk.cyan(String(manifests.length))} snapshots -- ` +
          `${chalk.cyan(String(filtered.length))} unique messages`,
      );

      return this.restore_batch(ctx, tenant_id, owner_id, target, 'mailbox', filtered);
    } finally {
      ctx.destroy();
    }
  }

  /** Loads all manifests for a mailbox, sorted newest-first and date-filtered. */
  private async load_mailbox_manifests(
    ctx: TenantContext,
    owner_id: string,
    options: RestoreOptions,
  ): Promise<Manifest[]> {
    const all = await this._manifests.list_all_manifests(ctx);
    const for_mailbox = all
      .filter((m) => m.owner_id === owner_id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return filter_manifests_by_date(for_mailbox, options.start_date, options.end_date);
  }

  /** Applies folder filter to a set of entries. */
  private async apply_entry_filters(
    entries: ManifestEntry[],
    owner_id: string,
    tenant_id: string,
    options: RestoreOptions,
  ): Promise<ManifestEntry[]> {
    if (options.folder_name) {
      const folder_map = await build_folder_map(this._connector, tenant_id, owner_id);
      return filter_entries_by_folder_name(entries, options.folder_name, folder_map);
    }
    return entries;
  }

  /** Loads and validates the manifest for a given snapshot. */
  private async load_manifest(ctx: TenantContext, snapshot_id: string): Promise<Manifest> {
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!manifest) throw new Error(`No manifest found for snapshot ${snapshot_id}`);
    return manifest;
  }

  /** Determines which entries to restore based on options. */
  private async resolve_entries(
    ctx: TenantContext,
    manifest: Manifest,
    owner_id: string,
    tenant_id: string,
    options: RestoreOptions,
  ): Promise<ManifestEntry[]> {
    if (options.message_ref) {
      const entry = this.resolve_single_entry(manifest, options.message_ref);
      return entry ? [entry] : [];
    }

    if (options.folder_name) {
      await backfill_missing_folder_ids(ctx, manifest.entries);
      const folder_map = await build_folder_map(this._connector, tenant_id, owner_id);
      return filter_entries_by_folder_name(manifest.entries, options.folder_name, folder_map);
    }

    return manifest.entries;
  }

  /** Resolves a single entry by 1-based index or object_id. */
  private resolve_single_entry(manifest: Manifest, ref: string): ManifestEntry | undefined {
    const index = Number(ref);
    if (Number.isInteger(index) && index >= 1) return manifest.entries[index - 1];
    return manifest.entries.find((e) => e.object_id === ref);
  }

  /** Restores a batch of messages with dashboard progress. */
  private async restore_batch(
    ctx: TenantContext,
    tenant_id: string,
    source_mailbox: string,
    target_mailbox: string,
    snapshot_id: string,
    entries: ManifestEntry[],
  ): Promise<RestoreResult> {
    const folder_map = await build_folder_map(this._connector, tenant_id, source_mailbox);
    await backfill_missing_folder_ids(ctx, entries);

    const groups = group_entries_by_folder(entries);
    const root = await create_restore_root(this._restore_connector, tenant_id, target_mailbox);
    const created_folders = new Map<string, string>();

    logger.info(
      `Restoring ${entries.length} messages across ` +
        `${count_unique_folders(entries)} folders into ${root.display_name}`,
    );

    const dashboard = new RestoreProgressDashboard(
      [...groups.entries()].map(([fid, items]) => ({
        name: folder_map.get(fid) ?? fid.slice(0, 12),
        total_items: items.length,
      })),
    );

    return execute_restore_loop(
      ctx,
      this._restore_connector,
      tenant_id,
      target_mailbox,
      snapshot_id,
      root,
      groups,
      folder_map,
      created_folders,
      dashboard,
    );
  }

  /** Fails fast if the target mailbox does not exist in the tenant. */
  private async assert_mailbox_exists(tenant_id: string, owner_id: string): Promise<void> {
    const exists = await this._connector.mailbox_exists(tenant_id, owner_id);
    if (!exists) {
      throw new Error(
        `Mailbox "${owner_id}" does not exist in the tenant. ` +
          `Verify the email address and try again.`,
      );
    }
  }

  private empty_result(snapshot_id: string): RestoreResult {
    return {
      snapshot_id,
      restored_count: 0,
      attachment_count: 0,
      error_count: 0,
      attachment_error_count: 0,
      errors: [],
      verification_warnings: [],
      restore_folder_name: '',
    };
  }
}
