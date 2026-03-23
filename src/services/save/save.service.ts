import { inject, injectable } from 'inversify';
import chalk from 'chalk';
import type { TenantContextFactory, TenantContext } from '@/ports/tenant/context.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
import type { SaveUseCase, SaveResult, SaveOptions } from '@/ports/save/use-case.port';
import {
  build_folder_map,
  group_entries_by_folder,
  filter_entries_by_folder_name,
  count_unique_folders,
} from '@/services/restore/folder-restore-planner';
import {
  filter_manifests_by_date,
  merge_snapshot_entries,
} from '@/services/restore/manifest-entry-merger';
import { backfill_missing_folder_ids } from '@/services/restore/restore-execution-orchestrator';
import { SaveProgressDashboard } from '@/services/save/save-progress-dashboard';
import { logger } from '@/utils/logger';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import { save_entries_to_archive } from '@/services/save/save-entry-processor';

@injectable()
export class SaveService implements SaveUseCase {
  private _interrupted = false;

  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
  ) {}

  async save_snapshot(
    tenant_id: string,
    snapshot_id: string,
    options: SaveOptions = {},
  ): Promise<SaveResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const manifest = await this.load_manifest(ctx, snapshot_id);
    const mailbox_id = manifest.mailbox_id;

    const entries = await this.resolve_entries(ctx, manifest, mailbox_id, tenant_id, options);
    if (entries.length === 0) {
      logger.warn('No entries to save');
      return this.empty_result(snapshot_id, options.output_path ?? '');
    }

    return this.save_batch(ctx, tenant_id, mailbox_id, snapshot_id, entries, options);
  }

  async save_mailbox(
    tenant_id: string,
    mailbox_id: string,
    options: SaveOptions = {},
  ): Promise<SaveResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const manifests = await this.load_mailbox_manifests(ctx, mailbox_id, options);

    if (manifests.length === 0) {
      logger.warn('No snapshots found for this mailbox in the given date range');
      return this.empty_result('mailbox', options.output_path ?? '');
    }

    const entries = merge_snapshot_entries(manifests);

    if (options.folder_name) {
      await backfill_missing_folder_ids(ctx, entries);
    }

    const filtered = await this.apply_entry_filters(entries, mailbox_id, tenant_id, options);
    if (filtered.length === 0) {
      logger.warn('No entries to save after filtering');
      return this.empty_result('mailbox', options.output_path ?? '');
    }

    logger.info(
      `Aggregated ${chalk.cyan(String(manifests.length))} snapshots -- ` +
        `${chalk.cyan(String(filtered.length))} unique messages`,
    );

    return this.save_batch(ctx, tenant_id, mailbox_id, 'mailbox', filtered, options);
  }

  private async load_manifest(ctx: TenantContext, snapshot_id: string): Promise<Manifest> {
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!manifest) throw new Error(`No manifest found for snapshot ${snapshot_id}`);
    return manifest;
  }

  private async load_mailbox_manifests(
    ctx: TenantContext,
    mailbox_id: string,
    options: SaveOptions,
  ): Promise<Manifest[]> {
    const all = await this._manifests.list_all_manifests(ctx);
    const for_mailbox = all
      .filter((m) => m.mailbox_id === mailbox_id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return filter_manifests_by_date(for_mailbox, options.start_date, options.end_date);
  }

  private async resolve_entries(
    ctx: TenantContext,
    manifest: Manifest,
    mailbox_id: string,
    tenant_id: string,
    options: SaveOptions,
  ): Promise<ManifestEntry[]> {
    if (options.message_ref) {
      const entry = this.resolve_single_entry(manifest, options.message_ref);
      return entry ? [entry] : [];
    }

    if (options.folder_name) {
      await backfill_missing_folder_ids(ctx, manifest.entries);
      const folder_map = await build_folder_map(this._connector, tenant_id, mailbox_id);
      return filter_entries_by_folder_name(manifest.entries, options.folder_name, folder_map);
    }

    return manifest.entries;
  }

  private resolve_single_entry(manifest: Manifest, ref: string): ManifestEntry | undefined {
    const index = Number(ref);
    if (Number.isInteger(index) && index >= 1) return manifest.entries[index - 1];
    return manifest.entries.find((e) => e.object_id === ref);
  }

  private async apply_entry_filters(
    entries: ManifestEntry[],
    mailbox_id: string,
    tenant_id: string,
    options: SaveOptions,
  ): Promise<ManifestEntry[]> {
    if (options.folder_name) {
      const folder_map = await build_folder_map(this._connector, tenant_id, mailbox_id);
      return filter_entries_by_folder_name(entries, options.folder_name, folder_map);
    }
    return entries;
  }

  private async save_batch(
    ctx: TenantContext,
    tenant_id: string,
    mailbox_id: string,
    snapshot_id: string,
    entries: ManifestEntry[],
    options: SaveOptions,
  ): Promise<SaveResult> {
    const folder_map = await build_folder_map(this._connector, tenant_id, mailbox_id);
    await backfill_missing_folder_ids(ctx, entries);

    const groups = group_entries_by_folder(entries);
    const output_path = options.output_path ?? build_default_output_path();
    const skip_integrity = options.skip_integrity_check ?? false;

    logger.info(
      `Saving ${entries.length} messages across ` +
        `${count_unique_folders(entries)} folders to ${chalk.cyan(output_path)}`,
    );

    if (skip_integrity) {
      logger.warn('Integrity verification is DISABLED (--skip-verify)');
    }

    const dashboard = new SaveProgressDashboard(
      [...groups.entries()].map(([fid, items]) => ({
        name: folder_map.get(fid) ?? fid.slice(0, 12),
        total_items: items.length,
      })),
    );

    return this.execute_save_loop(
      ctx,
      snapshot_id,
      output_path,
      skip_integrity,
      groups,
      folder_map,
      dashboard,
    );
  }

  private async execute_save_loop(
    ctx: TenantContext,
    snapshot_id: string,
    output_path: string,
    skip_integrity: boolean,
    groups: Map<string, ManifestEntry[]>,
    folder_map: Map<string, string>,
    dashboard: SaveProgressDashboard,
  ): Promise<SaveResult> {
    this._interrupted = false;
    const on_sigint = (): void => {
      this._interrupted = true;
    };
    process.on('SIGINT', on_sigint);

    try {
      const result = await save_entries_to_archive(
        ctx,
        output_path,
        skip_integrity,
        groups,
        folder_map,
        dashboard,
        () => this._interrupted,
      );

      if (this._interrupted) dashboard.mark_all_pending_interrupted();
      dashboard.finish();

      return { ...result, snapshot_id };
    } finally {
      process.removeListener('SIGINT', on_sigint);
    }
  }

  private empty_result(snapshot_id: string, output_path: string): SaveResult {
    return {
      snapshot_id,
      saved_count: 0,
      attachment_count: 0,
      error_count: 0,
      errors: [],
      output_path,
      total_bytes: 0,
      integrity_failures: [],
    };
  }
}

function build_default_output_path(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `Restore-${ts}.zip`;
}
