import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@atlas/types';
import type { MailboxConnector, MailFolder } from '@atlas/types';
import type { ManifestRepository } from '@atlas/types';
import type { ManifestEntry, ManifestObjectLockPolicy } from '@atlas/types';
import { calc_rate } from '@atlas/core/services/shared/progress-rate';
import { assert_mailbox_exists } from '@atlas/core/services/shared/mailbox-assertions';
import { sync_single_folder } from '@/services/backup/folder-sync-executor';
import {
  build_manifest,
  create_pending_snapshot,
  mark_snapshot_completed,
} from '@/services/backup/snapshot-manifest-builder';
import type {
  BackupProgressReporter,
  BackupUseCase,
  SyncOptions,
  SyncResult,
  BackupSyncMode,
} from '@atlas/types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
} from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

class NoopBackupProgressReporter implements BackupProgressReporter {
  set_status(): void {}
  mark_active(): void {}
  update_active(): void {}
  update_paging(): void {}
  mark_done(): void {}
  mark_all_pending_interrupted(): void {}
  mark_error(): void {}
  update_total(): void {}
  finish(): void {}
}

const NOOP_BACKUP_PROGRESS_REPORTER = new NoopBackupProgressReporter();
const always_false = (): boolean => false;

@injectable()
export class MailboxSyncService implements BackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /** Orchestrates a full or incremental mailbox backup across all (or filtered) folders. */
  async sync_mailbox(
    tenant_id: string,
    owner_id: string,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    owner_id = owner_id.toLowerCase();
    await assert_mailbox_exists(this._connector, tenant_id, owner_id);
    const ctx = await this._tenant_factory.create(tenant_id);
    await this.warn_if_replica(ctx);
    const snapshot = create_pending_snapshot(tenant_id, owner_id, {
      owner_email: options.owner_email,
      owner_display_name: options.owner_display_name,
    });
    const sync_start = Date.now();
    const should_interrupt: () => boolean = options.should_interrupt ?? always_false;
    const should_force_stop: () => boolean = options.should_force_stop ?? always_false;

    const previous = options.force_full
      ? undefined
      : await this._manifests.find_latest_by_owner(ctx, owner_id);
    const saved_links = previous?.delta_links ?? {};
    const previous_entry_count = previous?.total_objects ?? 0;
    const mode = this.resolve_sync_mode(options, saved_links);

    const all_folders = await this._connector.list_mail_folders(tenant_id, owner_id);
    const folder_selection = this.apply_folder_filter(all_folders, options.folder_filter);
    const folders = folder_selection.folders;
    const warnings = [...folder_selection.warnings];
    const progress =
      options.progress ??
      options.create_progress?.(
        folders.map((f) => ({ name: f.display_name, total_items: f.total_item_count })),
      ) ??
      NOOP_BACKUP_PROGRESS_REPORTER;
    const global_total = folders.reduce((sum, f) => sum + f.total_item_count, 0);

    const all_entries: ManifestEntry[] = [];
    const new_delta_links: Record<string, string> = {};
    let global_processed = 0;
    let stored = 0;
    let deduplicated = 0;
    let attachments_stored = 0;
    const folder_errors: string[] = [];

    for (let i = 0; i < folders.length; i++) {
      if (should_interrupt()) break;
      const folder = folders[i]!;
      progress.mark_active(i);

      let f_stored = 0;
      let f_deduped = 0;
      let f_att = 0;
      try {
        const prev_link = saved_links[folder.folder_id];
        const result = await sync_single_folder({
          ctx,
          connector: this._connector,
          tenant_id,
          owner_id,
          folder_id: folder.folder_id,
          folder_index: i,
          folder_total: folder.total_item_count,
          global_total,
          global_processed_before: global_processed,
          sync_start,
          progress,
          is_interrupted: should_interrupt,
          is_hard_stopped: should_force_stop,
          ...(prev_link !== undefined ? { prev_delta_link: prev_link } : {}),
          previous_manifest_entries: previous_entry_count,
          ...(options.page_size !== undefined ? { page_size: options.page_size } : {}),
          ...(options.object_lock_policy !== undefined
            ? { object_lock_policy: options.object_lock_policy }
            : {}),
        });
        all_entries.push(...result.entries);
        if (result.delta_link) {
          new_delta_links[folder.folder_id] = result.delta_link;
        }
        f_stored = result.stored;
        f_deduped = result.deduplicated;
        f_att = result.attachments_stored;
        stored += f_stored;
        deduplicated += f_deduped;
        attachments_stored += f_att;
        global_processed += result.folder_processed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        folder_errors.push(`${folder.display_name}: ${msg}`);
        progress.mark_error(i, msg);
        continue;
      }

      if (should_interrupt()) break;

      const rate = calc_rate(global_processed, Date.now() - sync_start);
      const eta = rate > 0 ? (global_total - global_processed) / rate : 0;
      progress.update_total(global_processed, global_total, rate, eta);
      progress.mark_done(i, f_stored, f_deduped, f_att);
    }

    if (should_interrupt()) progress.mark_all_pending_interrupted();
    progress.finish(global_processed);

    const merged_links = { ...saved_links, ...new_delta_links };
    const manifest = build_manifest(
      owner_id,
      snapshot.id,
      all_entries,
      merged_links,
      previous_entry_count,
      this.build_manifest_object_lock_policy(options),
    );
    await this._manifests.save(ctx, manifest);

    const completed = mark_snapshot_completed(snapshot, all_entries.length);
    return {
      snapshot: completed,
      manifest,
      mode,
      summary: {
        stored,
        deduplicated,
        attachments_stored,
        processed: global_processed,
        folder_errors,
        warnings,
        interrupted: should_interrupt(),
        completed_folder_count: Object.keys(new_delta_links).length,
        total_folder_count: folders.length,
        elapsed_ms: Date.now() - sync_start,
      },
    };
  }

  private build_manifest_object_lock_policy(
    options: SyncOptions,
  ): ManifestObjectLockPolicy | undefined {
    if (!options.object_lock_policy) return undefined;
    return {
      requested: {
        mode: options.object_lock_request?.mode,
        retention_days: options.object_lock_request?.retention_days,
      },
      effective: {
        mode: options.object_lock_policy.mode,
        retain_until: options.object_lock_policy.retain_until,
      },
    };
  }

  private resolve_sync_mode(
    options: SyncOptions,
    saved_links: Record<string, string>,
  ): BackupSyncMode {
    if (options.force_full) return 'full';
    if (Object.keys(saved_links).length > 0) return 'incremental';
    return 'initial';
  }

  /**
   * Filters the full folder list by display name (case-insensitive).
   * Returns all folders if no filter is specified.
   */
  private apply_folder_filter(
    folders: MailFolder[],
    filter?: string[],
  ): { folders: MailFolder[]; warnings: string[] } {
    if (!filter || filter.length === 0) return { folders, warnings: [] };

    const lower_filter = new Set(filter.map((f) => f.toLowerCase()));
    const matched = folders.filter((f) => lower_filter.has(f.display_name.toLowerCase()));
    const matched_names = new Set(matched.map((f) => f.display_name.toLowerCase()));
    const warnings: string[] = [];

    for (const name of lower_filter) {
      if (!matched_names.has(name)) {
        const available = folders.map((f) => f.display_name).join(', ');
        warnings.push(`Folder "${name}" not found. Available: ${available}`);
      }
    }

    return { folders: matched, warnings };
  }

  private async warn_if_replica(ctx: {
    storage: { exists(key: string): Promise<boolean> };
  }): Promise<void> {
    try {
      if (await ctx.storage.exists('_meta/replica.marker')) {
        logger.warn(
          'This storage target contains a replica marker (_meta/replica.marker). ' +
            'Running backup against a replica is not recommended -- use the primary storage.',
        );
      }
    } catch {
      /* non-critical: do not block backup if marker check fails */
    }
  }
}
