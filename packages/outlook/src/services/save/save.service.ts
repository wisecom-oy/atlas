import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { MailboxConnector } from '@wisecom/atlas-types';
import type { Manifest, ManifestEntry } from '@wisecom/atlas-types';
import type {
  SaveUseCase,
  SaveResult,
  SaveOptions,
  TransferProgressReporter,
} from '@wisecom/atlas-types';
import {
  build_folder_map,
  group_entries_by_folder,
  filter_entries_by_folder_name,
  count_unique_folders,
} from '@/services/restore/folder-restore-planner';
import { apply_recoverable_items_policy } from '@/services/restore/recoverable-items-filter';
import { filter_manifests_by_date, merge_snapshot_entries } from '@wisecom/atlas-core';
import { backfill_missing_folder_ids } from '@/services/restore/restore-execution-orchestrator';
import { NoopTransferProgressReporter } from '@/services/shared/noop-transfer-progress-reporter';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
} from '@wisecom/atlas-types';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import {
  resolve_save_target,
  settle_empty_save_target,
  settle_failed_save_target,
} from '@wisecom/atlas-core/services/shared/save-archive-target';
import { save_entries_to_archive } from '@/services/save/save-entry-processor';
import type { ArchiveTarget } from '@/services/save/save-zip-writer';

@injectable()
export class SaveService implements SaveUseCase {
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
    const { target, output_path } = resolve_save_target(options, build_default_output_path);
    try {
      if (begin_operation_progress(options, 'save', 'outlook')) {
        return await this.finish_empty_result(snapshot_id, options, target);
      }
      const ctx = await this._tenant_factory.create(tenant_id);
      try {
        const manifest = await this.load_manifest(ctx, snapshot_id);
        const owner_id = manifest.owner_id;

        const entries = await this.resolve_entries(ctx, manifest, owner_id, tenant_id, options);
        if (entries.length === 0) {
          logger.warn('No entries to save');
          return await this.finish_empty_result(snapshot_id, options, target);
        }

        return this.save_batch(
          ctx,
          tenant_id,
          owner_id,
          snapshot_id,
          entries,
          options,
          target,
          output_path,
        );
      } finally {
        ctx.destroy();
      }
    } catch (err) {
      settle_failed_save_target(target);
      throw err;
    }
  }

  async save_mailbox(
    tenant_id: string,
    owner_id: string,
    options: SaveOptions = {},
  ): Promise<SaveResult> {
    const { target, output_path } = resolve_save_target(options, build_default_output_path);
    try {
      if (begin_operation_progress(options, 'save', 'outlook')) {
        return await this.finish_empty_result('mailbox', options, target);
      }
      const ctx = await this._tenant_factory.create(tenant_id);
      try {
        const manifests = await this.load_mailbox_manifests(ctx, owner_id, options);

        if (manifests.length === 0) {
          logger.warn('No snapshots found for this mailbox in the given date range');
          return await this.finish_empty_result('mailbox', options, target);
        }

        const entries = merge_snapshot_entries(manifests);

        if (options.folder_name) {
          await backfill_missing_folder_ids(ctx, entries);
        }

        const filtered = await this.apply_entry_filters(entries, owner_id, tenant_id, options);
        if (filtered.length === 0) {
          logger.warn('No entries to save after filtering');
          return await this.finish_empty_result('mailbox', options, target);
        }

        logger.info(
          `Aggregated ${manifests.length} snapshots -- ${filtered.length} unique messages`,
        );

        return this.save_batch(
          ctx,
          tenant_id,
          owner_id,
          'mailbox',
          filtered,
          options,
          target,
          output_path,
        );
      } finally {
        ctx.destroy();
      }
    } catch (err) {
      settle_failed_save_target(target);
      throw err;
    }
  }

  private async load_manifest(ctx: TenantContext, snapshot_id: string): Promise<Manifest> {
    const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
    if (!manifest) throw new Error(`No manifest found for snapshot ${snapshot_id}`);
    return manifest;
  }

  private async load_mailbox_manifests(
    ctx: TenantContext,
    owner_id: string,
    options: SaveOptions,
  ): Promise<Manifest[]> {
    const all = await this._manifests.list_all_manifests(ctx);
    const for_mailbox = all
      .filter((m) => m.owner_id === owner_id)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return filter_manifests_by_date(for_mailbox, options.start_date, options.end_date);
  }

  private async resolve_entries(
    ctx: TenantContext,
    manifest: Manifest,
    owner_id: string,
    tenant_id: string,
    options: SaveOptions,
  ): Promise<ManifestEntry[]> {
    const allowed = apply_recoverable_items_policy(
      manifest.entries,
      options.include_recoverable_items,
    );

    if (options.message_ref) {
      const entry = this.resolve_single_entry(manifest, options.message_ref);
      return entry && allowed.includes(entry) ? [entry] : [];
    }

    if (options.folder_name) {
      await backfill_missing_folder_ids(ctx, allowed);
      const folder_map = await build_folder_map(this._connector, tenant_id, owner_id);
      return filter_entries_by_folder_name(allowed, options.folder_name, folder_map);
    }

    return allowed;
  }

  private resolve_single_entry(manifest: Manifest, ref: string): ManifestEntry | undefined {
    const index = Number(ref);
    if (Number.isInteger(index) && index >= 1) return manifest.entries[index - 1];
    return manifest.entries.find((e) => e.object_id === ref);
  }

  private async apply_entry_filters(
    entries: ManifestEntry[],
    owner_id: string,
    tenant_id: string,
    options: SaveOptions,
  ): Promise<ManifestEntry[]> {
    const allowed = apply_recoverable_items_policy(entries, options.include_recoverable_items);
    if (options.folder_name) {
      const folder_map = await build_folder_map(this._connector, tenant_id, owner_id);
      return filter_entries_by_folder_name(allowed, options.folder_name, folder_map);
    }
    return allowed;
  }

  private async save_batch(
    ctx: TenantContext,
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    entries: ManifestEntry[],
    options: SaveOptions,
    target: ArchiveTarget,
    output_path: string,
  ): Promise<SaveResult> {
    const folder_map = await build_folder_map(this._connector, tenant_id, owner_id);
    await backfill_missing_folder_ids(ctx, entries);

    const groups = group_entries_by_folder(entries);
    const skip_integrity = options.skip_integrity_check ?? false;

    logger.info(
      `Saving ${entries.length} messages across ` +
        `${count_unique_folders(entries)} folders to ${output_path || '(stream)'}`,
    );

    if (skip_integrity) {
      logger.warn('Integrity verification is DISABLED (--skip-verify)');
    }

    const folder_summaries = [...groups.entries()].map(([fid, items]) => ({
      name: folder_map.get(fid) ?? fid.slice(0, 12),
      total_items: items.length,
    }));
    const dashboard =
      options.create_progress?.(folder_summaries) ?? new NoopTransferProgressReporter();

    return this.execute_save_loop(
      ctx,
      snapshot_id,
      target,
      output_path,
      skip_integrity,
      groups,
      folder_map,
      dashboard,
      options,
    );
  }

  private async execute_save_loop(
    ctx: TenantContext,
    snapshot_id: string,
    target: ArchiveTarget,
    output_path: string,
    skip_integrity: boolean,
    groups: Map<string, ManifestEntry[]>,
    folder_map: Map<string, string>,
    dashboard: TransferProgressReporter,
    options: SaveOptions,
  ): Promise<SaveResult> {
    let sigint_interrupted = false;
    const on_sigint = (): void => {
      sigint_interrupted = true;
    };
    const is_interrupted = (): boolean =>
      sigint_interrupted || options.should_interrupt?.() === true;
    process.on('SIGINT', on_sigint);

    try {
      const result = await save_entries_to_archive(
        ctx,
        target,
        output_path,
        skip_integrity,
        groups,
        folder_map,
        dashboard,
        is_interrupted,
        options,
      );

      const { processed, ...save_result } = result;
      const interrupted = result.interrupted || is_interrupted();
      if (interrupted) dashboard.mark_all_pending_interrupted();
      dashboard.finish();
      emit_operation_progress(options, {
        operation: 'save',
        workload: 'outlook',
        phase: interrupted ? 'interrupted' : 'completed',
        processed,
        total: [...groups.values()].reduce((sum, entries) => sum + entries.length, 0),
      });

      return { ...save_result, snapshot_id, interrupted };
    } finally {
      process.removeListener('SIGINT', on_sigint);
    }
  }

  private async finish_empty_result(
    snapshot_id: string,
    options: SaveOptions,
    target: ArchiveTarget,
  ): Promise<SaveResult> {
    const interrupted = finish_operation_progress(options, 'save', 'outlook', 0, 0);
    await settle_empty_save_target(target, interrupted);
    // No archive landed anywhere, so there is no path to report even when one was requested.
    return this.empty_result(snapshot_id, options.output_path ?? '', interrupted);
  }

  private empty_result(snapshot_id: string, output_path: string, interrupted = false): SaveResult {
    return {
      snapshot_id,
      saved_count: 0,
      attachment_count: 0,
      error_count: 0,
      errors: [],
      output_path,
      total_bytes: 0,
      integrity_failures: [],
      interrupted,
    };
  }
}

function build_default_output_path(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `Restore-${ts}.zip`;
}
