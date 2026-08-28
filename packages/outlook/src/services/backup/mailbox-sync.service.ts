import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import type { MailboxConnector, MailFolder, ManifestRepository } from '@wisecom/atlas-types';
import type { ManifestEntry, ManifestObjectLockPolicy } from '@wisecom/atlas-types';
import { calc_rate } from '@wisecom/atlas-core/services/shared/progress-rate';
import { assert_mailbox_exists } from '@wisecom/atlas-core/services/shared/mailbox-assertions';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { sync_single_folder } from '@/services/backup/folder-sync-executor';
import { resolve_backup_folders } from '@/services/shared/folder-selector';
import { resolve_progress_reporter } from '@/services/shared/backup-progress-resolver';
import {
  build_manifest,
  create_pending_snapshot,
  mark_snapshot_completed,
  resolve_saved_delta_links,
  resolve_sync_mode,
} from '@/services/backup/snapshot-manifest-builder';
import {
  build_interrupted_result,
  mark_progress_interrupted,
} from '@/services/backup/outlook-interrupted-result';
import type {
  BackupProgressReporter,
  BackupUseCase,
  SyncOptions,
  SyncResult,
} from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

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
    owner_id = normalize_owner_id(owner_id);
    if (begin_operation_progress(options, 'backup', 'outlook')) {
      finish_operation_progress(options, 'backup', 'outlook', 0, 0);
      return build_interrupted_result(tenant_id, owner_id, options);
    }
    await assert_mailbox_exists(this._connector, tenant_id, owner_id);
    const mailbox_purpose = await this._connector.get_mailbox_purpose?.(tenant_id, owner_id);
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
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
      const saved_links = resolve_saved_delta_links(previous);
      const previous_entry_count = previous?.total_objects ?? 0;
      const mode = resolve_sync_mode(options.force_full, saved_links);

      const folder_selection = await resolve_backup_folders(this._connector, tenant_id, owner_id, {
        folder_filter: options.folder_filter,
        exclude_junk: options.exclude_junk,
      });
      const folders = folder_selection.folders;
      const warnings = [...folder_selection.warnings];
      const excluded_folders = folder_selection.excluded;
      const progress = resolve_progress_reporter(options, folders);
      const global_total = folders.reduce((sum, f) => sum + f.total_item_count, 0);
      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'outlook',
        phase: 'processing',
        processed: 0,
        total: global_total,
      });

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

        const outcome = await this.sync_single_folder_with_progress(
          ctx,
          tenant_id,
          owner_id,
          folder,
          i,
          saved_links,
          previous_entry_count,
          global_total,
          global_processed,
          sync_start,
          progress,
          options,
          should_interrupt,
          should_force_stop,
        );

        if (outcome.error) {
          folder_errors.push(`${folder.folder_path}: ${outcome.error}`);
          progress.mark_error(i, outcome.error);
          continue;
        }

        all_entries.push(...outcome.entries);
        // Persist a folder's delta link only when every page was fully processed;
        // an interrupted folder keeps its previous link and is re-enumerated next run (issue #23).
        if (outcome.delta_link && outcome.complete) {
          new_delta_links[folder.folder_id] = outcome.delta_link;
        }
        stored += outcome.stored;
        deduplicated += outcome.deduplicated;
        attachments_stored += outcome.attachments_stored;
        global_processed += outcome.folder_processed;

        if (should_interrupt()) break;

        const rate = calc_rate(global_processed, Date.now() - sync_start);
        const eta = rate > 0 ? (global_total - global_processed) / rate : 0;
        progress.update_total(global_processed, global_total, rate, eta);
        progress.mark_done(i, outcome.stored, outcome.deduplicated, outcome.attachments_stored);
      }

      let interrupted = mark_progress_interrupted(progress, should_interrupt());
      progress.finish(global_processed);
      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'outlook',
        phase: 'finalizing',
        processed: global_processed,
        total: global_total,
      });

      const merged_links = { ...saved_links, ...new_delta_links };
      const manifest = build_manifest(owner_id, snapshot.id, all_entries, merged_links, {
        previous_total_objects: previous_entry_count,
        object_lock: this.build_manifest_object_lock_policy(options),
        mailbox_purpose,
        excluded_folders,
      });
      await this._manifests.save(ctx, manifest);
      interrupted ||= should_interrupt();
      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'outlook',
        phase: interrupted ? 'interrupted' : 'completed',
        processed: global_processed,
        total: global_total,
      });

      const completed = mark_snapshot_completed(snapshot, all_entries.length);
      return {
        snapshot: completed,
        manifest,
        mode,
        interrupted,
        summary: {
          stored,
          deduplicated,
          attachments_stored,
          processed: global_processed,
          folder_errors,
          warnings,
          interrupted,
          completed_folder_count: Object.keys(new_delta_links).length,
          total_folder_count: folders.length,
          elapsed_ms: Date.now() - sync_start,
          excluded_folders,
        },
      };
    } finally {
      ctx.destroy();
    }
  }

  /** Syncs one folder and updates progress; returns aggregated results or an error message. */
  private async sync_single_folder_with_progress(
    ctx: TenantContext,
    tenant_id: string,
    owner_id: string,
    folder: MailFolder,
    folder_index: number,
    saved_links: Record<string, string>,
    previous_entry_count: number,
    global_total: number,
    global_processed_before: number,
    sync_start: number,
    progress: BackupProgressReporter,
    options: SyncOptions,
    should_interrupt: () => boolean,
    should_force_stop: () => boolean,
  ): Promise<{
    entries: ManifestEntry[];
    delta_link?: string;
    complete: boolean;
    stored: number;
    deduplicated: number;
    attachments_stored: number;
    folder_processed: number;
    error?: string;
  }> {
    try {
      const prev_link = saved_links[folder.folder_id];
      const result = await sync_single_folder({
        ctx,
        connector: this._connector,
        tenant_id,
        owner_id,
        folder_id: folder.folder_id,
        folder_index,
        folder_total: folder.total_item_count,
        global_total,
        global_processed_before,
        sync_start,
        progress,
        is_interrupted: should_interrupt,
        is_hard_stopped: should_force_stop,
        operation_control: options,
        ...(prev_link !== undefined ? { prev_delta_link: prev_link } : {}),
        previous_manifest_entries: previous_entry_count,
        ...(options.page_size !== undefined ? { page_size: options.page_size } : {}),
        ...(options.object_lock_policy !== undefined
          ? { object_lock_policy: options.object_lock_policy }
          : {}),
      });
      return {
        entries: result.entries,
        ...(result.delta_link !== undefined ? { delta_link: result.delta_link } : {}),
        complete: result.complete,
        stored: result.stored,
        deduplicated: result.deduplicated,
        attachments_stored: result.attachments_stored,
        folder_processed: result.folder_processed,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        entries: [],
        complete: false,
        stored: 0,
        deduplicated: 0,
        attachments_stored: 0,
        folder_processed: 0,
        error: msg,
      };
    }
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
