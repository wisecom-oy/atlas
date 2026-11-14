import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { run_cancellable } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import type { HeldOwnerLease, OwnerLeasePort } from '@wisecom/atlas-types';
import type { MailboxConnector, ManifestRepository } from '@wisecom/atlas-types';
import type { MailboxDeltaCursorRepository } from '@wisecom/atlas-types';
import type { ManifestEntry } from '@wisecom/atlas-types';
import { calc_rate } from '@wisecom/atlas-core/services/shared/progress-rate';
import { assert_mailbox_exists } from '@wisecom/atlas-core/services/shared/mailbox-assertions';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { sync_single_folder_with_progress } from '@/services/backup/folder-sync-attempt';
import { persist_mailbox_run, resolve_resume_state } from '@/services/backup/mailbox-run-persister';
import { count_run_objects, distinct_unreadable_keys } from '@/services/backup/run-object-count';
import { warn_if_replica } from '@/services/backup/replica-marker-warning';
import { resolve_backup_folders } from '@/services/shared/folder-selector';
import { resolve_progress_reporter } from '@/services/shared/backup-progress-resolver';
import {
  build_manifest,
  build_manifest_object_lock_policy,
  count_folders_to_finish,
  create_pending_snapshot,
  mark_snapshot_completed,
  resolve_saved_delta_links,
  resolve_sync_mode,
  select_recordable_removals,
  withhold_links_of_unrecorded_removals,
} from '@/services/backup/snapshot-manifest-builder';
import {
  build_interrupted_result,
  mark_progress_interrupted,
} from '@/services/backup/outlook-interrupted-result';
import type { BackupUseCase, SyncOptions, SyncResult } from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  MAILBOX_DELTA_CURSOR_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

const always_false = (): boolean => false;

@injectable()
export class MailboxSyncService implements BackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(MAILBOX_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: MailboxDeltaCursorRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Orchestrates a full or incremental mailbox backup across all (or filtered) folders.
   *
   * The run's abort signal is published to every Graph call inside it, so cancelling also ends a
   * Graph retry or throttle wait rather than only the next page (issue #673).
   *
   * The run holds the mailbox's lease from before it reads the cursor until it ends.
   *
   * @throws OwnerBusyError when another operation holds the mailbox's backup.
   */
  async sync_mailbox(
    tenant_id: string,
    owner_id: string,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    owner_id = normalize_owner_id(owner_id);
    const cancelled = (): SyncResult => {
      finish_operation_progress(options, 'backup', 'outlook', 0, 0, true);
      return build_interrupted_result(tenant_id, owner_id, options);
    };
    if (begin_operation_progress(options, 'backup', 'outlook')) return cancelled();
    return run_cancellable(options, () => this.run_sync(tenant_id, owner_id, options), cancelled);
  }

  private async run_sync(
    tenant_id: string,
    owner_id: string,
    options: SyncOptions,
  ): Promise<SyncResult> {
    await assert_mailbox_exists(this._connector, tenant_id, owner_id);
    const mailbox_purpose = await this._connector.get_mailbox_purpose?.(tenant_id, owner_id);
    // Before the tenant context, so selectors that match no folder fail before storage is touched.
    const folder_selection = await resolve_backup_folders(this._connector, tenant_id, owner_id, {
      folder_filter: options.folder_filter,
      exclude_junk: options.exclude_junk,
      include_recoverable_items: options.include_recoverable_items,
    });
    const ctx = await this._tenant_factory.create(tenant_id);
    let lease: HeldOwnerLease | undefined;
    try {
      // Taken before the cursor is read, released in the `finally` below (issue #623).
      lease = await this._leases.acquire(ctx, {
        workload: 'outlook',
        owner_id,
        operation: 'backup',
      });
      await warn_if_replica(ctx);
      const snapshot = create_pending_snapshot(tenant_id, owner_id, {
        owner_email: options.owner_email,
        owner_display_name: options.owner_display_name,
      });
      const sync_start = Date.now();
      const should_interrupt = (): boolean =>
        options.should_interrupt?.() === true || options.abort_signal?.aborted === true;
      const should_force_stop: () => boolean = options.should_force_stop ?? always_false;

      const resume = await resolve_resume_state(
        { manifests: this._manifests, cursors: this._cursors },
        ctx,
        owner_id,
        options.force_full === true,
      );
      const { previous, saved_links, previous_entry_count, mode } = resume;
      // Read even on a full run: the snapshot it writes still heads the whole chain (issue #711).
      const chain_rows = await this._manifests.list_snapshot_summaries(ctx, owner_id);
      const unreadable_keys = distinct_unreadable_keys(
        resume.unreadable_keys,
        chain_rows.unreadable_keys,
      );

      const folders = folder_selection.folders;
      const warnings: string[] = [];
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
      const removed_ids: string[] = [];
      const removal_counts: Record<string, number> = {};
      let global_processed = 0;
      let stored = 0;
      let deduplicated = 0;
      let attachments_stored = 0;
      let reactions_not_captured = 0;
      // A selector that matched nothing leaves the run incomplete while others still matched.
      const folder_errors: string[] = [...folder_selection.selector_errors];

      for (let i = 0; i < folders.length; i++) {
        if (should_interrupt()) break;
        const folder = folders[i]!;
        progress.mark_active(i);

        const outcome = await sync_single_folder_with_progress(
          this._connector,
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

        // Per-message MIME and attachment failures, not folder failures: the folder's entries are
        // kept and the run reports itself incomplete rather than losing the folder (issue #366).
        append_all(
          folder_errors,
          outcome.message_errors.map((line) => `${folder.folder_path}: ${line}`),
        );
        append_all(
          warnings,
          outcome.warnings.map((line) => `${folder.folder_path}: ${line}`),
        );

        append_all(all_entries, outcome.entries);
        append_all(removed_ids, outcome.removed_ids);
        removal_counts[folder.folder_id] = outcome.removed_ids.length;
        // Persist a folder's delta link only when every page and message was fully processed; an
        // interrupted or partly failed folder keeps its previous link and is re-enumerated next
        // run (issues #23, #614, #615).
        if (outcome.delta_link && outcome.complete) {
          new_delta_links[folder.folder_id] = outcome.delta_link;
        }
        stored += outcome.stored;
        deduplicated += outcome.deduplicated;
        attachments_stored += outcome.attachments_stored;
        reactions_not_captured += outcome.reactions_not_captured;
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

      const merged_links = {
        ...saved_links,
        ...withhold_links_of_unrecorded_removals(
          new_delta_links,
          removal_counts,
          count_folders_to_finish(folders, excluded_folders, options.folder_filter),
        ),
      };
      const manifest = build_manifest(owner_id, snapshot.id, all_entries, merged_links, {
        previous_total_objects: previous_entry_count,
        object_lock: build_manifest_object_lock_policy(options),
        mailbox_purpose,
        excluded_folders,
        folders,
        owner_email: options.owner_email,
        owner_display_name: options.owner_display_name,
        removed_object_ids: select_recordable_removals(removed_ids, options.folder_filter, {
          completed: Object.keys(new_delta_links).length,
          selected: folders.length,
          excluded: excluded_folders,
        }),
      });

      const persisted = await persist_mailbox_run(
        { manifests: this._manifests, cursors: this._cursors },
        ctx,
        lease,
        manifest,
        snapshot,
        previous,
        count_run_objects(chain_rows.summaries, manifest, previous),
      );

      interrupted ||= should_interrupt();
      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'outlook',
        phase: interrupted ? 'interrupted' : 'completed',
        processed: global_processed,
        total: global_total,
      });

      const completed = persisted.snapshot;
      return {
        snapshot: completed,
        manifest,
        mode,
        interrupted,
        snapshot_stored: true,
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
          reactions_not_captured,
          ...(unreadable_keys.length > 0 ? { unreadable_keys } : {}),
        },
      };
    } finally {
      await lease?.release();
      ctx.destroy();
    }
  }
}
