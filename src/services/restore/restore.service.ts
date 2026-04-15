import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { TenantContextFactory, TenantContext } from '@/ports/tenant/context.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { RestoreConnector } from '@/ports/restore/connector.port';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
import {
  build_folder_map,
  create_restore_root,
  ensure_subfolder,
  group_entries_by_folder,
  filter_entries_by_folder_name,
  count_unique_folders,
} from '@/services/restore/folder-restore-planner';
import {
  load_mailbox_manifests,
  merge_snapshot_entries,
} from '@/services/restore/manifest-entry-merger';
import {
  restore_single_message,
  restore_folder_entries,
  backfill_missing_folder_ids,
  log_restore_summary,
} from '@/services/restore/restore-execution-orchestrator';
import { verify_folder_message_count } from '@/services/restore/restore-folder-verifier';
import { RestoreProgressDashboard } from '@/services/restore/restore-progress-dashboard';
import { calc_rate } from '@/services/shared/progress-rate';
import { logger } from '@/utils/logger';
import type { RestoreUseCase, RestoreResult, RestoreOptions } from '@/ports/restore/use-case.port';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
} from '@/ports/tokens/outgoing.tokens';

@injectable()
export class RestoreService implements RestoreUseCase {
  private _interrupted = false;

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
    const manifest = await this.load_manifest(ctx, snapshot_id);
    const source_mailbox = manifest.mailbox_id;
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

    return this.restore_batch(ctx, tenant_id, source_mailbox, target_mailbox, snapshot_id, entries);
  }

  /**
   * Restores messages from all snapshots for a mailbox, merging and
   * deduplicating entries. Supports date range filtering and folder filter.
   */
  async restore_mailbox(
    tenant_id: string,
    mailbox_id: string,
    options: RestoreOptions = {},
  ): Promise<RestoreResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const target = options.target_mailbox?.toLowerCase() ?? mailbox_id;

    await this.assert_mailbox_exists(tenant_id, target);

    const manifests = await load_mailbox_manifests(
      this._manifests,
      ctx,
      mailbox_id,
      options.start_date,
      options.end_date,
    );
    if (manifests.length === 0) {
      logger.warn('No snapshots found for this mailbox in the given date range');
      return this.empty_result('mailbox');
    }

    const entries = merge_snapshot_entries(manifests);

    if (options.folder_name) {
      await backfill_missing_folder_ids(ctx, entries);
      const folder_map = await build_folder_map(this._connector, tenant_id, mailbox_id);
      const filtered = filter_entries_by_folder_name(entries, options.folder_name, folder_map);
      if (filtered.length === 0) {
        logger.warn('No entries to restore after filtering');
        return this.empty_result('mailbox');
      }
      logger.info(
        `Aggregated ${chalk.cyan(String(manifests.length))} snapshots -- ` +
          `${chalk.cyan(String(filtered.length))} unique messages`,
      );
      return this.restore_batch(ctx, tenant_id, mailbox_id, target, 'mailbox', filtered);
    }

    if (entries.length === 0) {
      logger.warn('No entries to restore after filtering');
      return this.empty_result('mailbox');
    }

    logger.info(
      `Aggregated ${chalk.cyan(String(manifests.length))} snapshots -- ` +
        `${chalk.cyan(String(entries.length))} unique messages`,
    );

    return this.restore_batch(ctx, tenant_id, mailbox_id, target, 'mailbox', entries);
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
    mailbox_id: string,
    tenant_id: string,
    options: RestoreOptions,
  ): Promise<ManifestEntry[]> {
    if (options.message_ref) {
      const entry = resolve_single_entry(manifest, options.message_ref);
      return entry ? [entry] : [];
    }

    if (options.folder_name) {
      await backfill_missing_folder_ids(ctx, manifest.entries);
      const folder_map = await build_folder_map(this._connector, tenant_id, mailbox_id);
      return filter_entries_by_folder_name(manifest.entries, options.folder_name, folder_map);
    }

    return manifest.entries;
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

    return this.execute_restore_loop(
      ctx,
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

  /** Main restore loop: iterates folders then messages with dashboard updates. */
  private async execute_restore_loop(
    ctx: TenantContext,
    tenant_id: string,
    target_mailbox: string,
    snapshot_id: string,
    root: { folder_id: string; display_name: string },
    groups: Map<string, ManifestEntry[]>,
    folder_map: Map<string, string>,
    created_folders: Map<string, string>,
    dashboard: RestoreProgressDashboard,
  ): Promise<RestoreResult> {
    let global_restored = 0;
    let global_att = 0;
    let global_errors = 0;
    let global_att_errors = 0;
    const all_errors: string[] = [];
    const start = Date.now();
    const global_total = [...groups.values()].reduce((s, g) => s + g.length, 0);

    this._interrupted = false;
    const on_sigint = (): void => {
      this._interrupted = true;
    };
    process.on('SIGINT', on_sigint);

    try {
      let folder_index = 0;
      for (const [fid, folder_items] of groups) {
        if (this._interrupted) break;
        dashboard.mark_active(folder_index);

        const target_fid = await ensure_subfolder(
          this._restore_connector,
          tenant_id,
          target_mailbox,
          root.folder_id,
          fid,
          folder_map,
          created_folders,
        );

        const result = await restore_folder_entries(
          ctx,
          this._restore_connector,
          tenant_id,
          target_mailbox,
          target_fid,
          folder_items,
          folder_index,
          global_restored,
          global_total,
          start,
          dashboard,
          () => this._interrupted,
        );

        global_restored += result.restored;
        global_att += result.attachments;
        global_att_errors += result.attachment_errors;
        global_errors += result.errors.length;
        all_errors.push(...result.errors);

        await verify_folder_message_count(
          this._restore_connector,
          tenant_id,
          target_mailbox,
          target_fid,
          result.restored,
          folder_map.get(fid) ?? fid.slice(0, 12),
        );

        const rate = calc_rate(global_restored, Date.now() - start);
        const eta = rate > 0 ? (global_total - global_restored) / rate : 0;
        dashboard.update_total(global_restored, global_total, rate, eta);

        if (this._interrupted) break;
        dashboard.mark_done(folder_index, result.restored, result.attachments);
        folder_index++;
      }

      if (this._interrupted) dashboard.mark_all_pending_interrupted();
      dashboard.finish(global_restored);
      log_restore_summary(global_restored, global_att, global_errors, start);

      return {
        snapshot_id,
        restored_count: global_restored,
        attachment_count: global_att,
        error_count: global_errors,
        attachment_error_count: global_att_errors,
        errors: all_errors,
        restore_folder_name: root.display_name,
      };
    } finally {
      process.removeListener('SIGINT', on_sigint);
    }
  }

  /** Fails fast if the target mailbox does not exist in the tenant. */
  private async assert_mailbox_exists(tenant_id: string, mailbox_id: string): Promise<void> {
    const exists = await this._connector.mailbox_exists(tenant_id, mailbox_id);
    if (!exists) {
      throw new Error(
        `Mailbox "${mailbox_id}" does not exist in the tenant. ` +
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
      restore_folder_name: '',
    };
  }
}

/** Resolves a single entry by 1-based index or object_id. */
function resolve_single_entry(manifest: Manifest, ref: string): ManifestEntry | undefined {
  const index = Number(ref);
  if (Number.isInteger(index) && index >= 1) return manifest.entries[index - 1];
  return manifest.entries.find((e) => e.object_id === ref);
}
