// Deliberately not shared with the SharePoint copy (#306): 306 differing lines of 604. OneDrive
// enumerates an owner's drives and carries a folder scope and a per-drive delta cursor;
// SharePoint walks a site tree, then libraries within it, and has no folder scope. Unifying
// them means a parameter per branch, which is the shape that made the copies hard to change.
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { with_summary_unreadable_keys } from '@wisecom/atlas-core/services/shared/unreadable-object-report';
import { attach_run_retention } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { run_cancellable } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { randomBytes } from 'node:crypto';
import {
  begin_operation_progress,
  emit_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import { classify_empty_run } from '@wisecom/atlas-drive/backup/empty-run-classifier';
import type {
  BackupProgressReporter,
  HeldOwnerLease,
  OneDriveBackupOptions,
  OneDriveBackupResult,
  OneDriveBackupUseCase,
  OneDriveConnector,
  OneDriveDeltaCursor,
  OneDriveDeltaCursorRepository,
  OneDriveFileVersionIndexRepository,
  OneDriveManifestRepository,
  OwnerLeasePort,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN,
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  build_empty_result,
  build_run_version_indexes,
  build_snapshot_manifest,
  build_success_result,
  persist_snapshot_backup,
} from '@/services/backup/backup-builders';
import { load_run_version_collector } from '@/services/versioning/run-version-collector';
import { scan_all_drives } from '@/services/backup/backup-drive-processor';
import { build_package_warnings } from '@/services/backup/package-report';
import { interrupted_before_scan } from '@/services/backup/interrupted-scan-result';
import { cleanup_stale_staging } from '@/services/backup/large-file-pipeline';
import {
  has_folder_scope_changed,
  is_path_within_folder_scope,
  normalize_folder_scope,
} from '@/services/backup/folder-scope';
import { append_recrawl_tombstones } from '@wisecom/atlas-drive/backup/recrawl-tombstones';
import { merge_damaged_manifest_keys } from '@wisecom/atlas-drive/backup/damaged-manifest-report';
import {
  resolve_saved_cursor_binding,
  select_resumable_cursor,
} from '@wisecom/atlas-drive/shared/cursor-snapshot-binding';
import { ONEDRIVE_KEYS } from '@/services/shared/storage-keys';
import { build_version_errors } from '@wisecom/atlas-drive/backup/version-failure-errors';
import { describe_failed_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

@injectable()
export class OneDriveBackupService implements OneDriveBackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _file_indexes: OneDriveFileVersionIndexRepository,
    @inject(ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: OneDriveDeltaCursorRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Backs up changed OneDrive files and creates a snapshot only when data changed.
   *
   * The run's abort signal is published to every Graph call inside it, so cancelling also ends a
   * Graph retry or throttle wait rather than only the next file (issue #673).
   *
   * The run holds the owner's OneDrive lease from before it reads the cursor until it ends.
   *
   * @throws OwnerBusyError when another operation holds the owner's OneDrive backup.
   */
  async backup_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveBackupOptions = {},
  ): Promise<OneDriveBackupResult> {
    owner_id = normalize_owner_id(owner_id);
    const cancelled = (): OneDriveBackupResult => interrupted_before_scan(owner_id, options);
    if (begin_operation_progress(options, 'backup', 'onedrive')) return cancelled();
    return run_cancellable(options, () => this.run_backup(tenant_id, owner_id, options), cancelled);
  }

  private async run_backup(
    tenant_id: string,
    owner_id: string,
    options: OneDriveBackupOptions,
  ): Promise<OneDriveBackupResult> {
    const tenant_ctx = await this._tenant_factory.create(tenant_id);
    let progress: BackupProgressReporter | undefined;
    let lease: HeldOwnerLease | undefined;
    try {
      // Taken before the cursor is read, released in the `finally` below (issue #623).
      lease = await this._leases.acquire(tenant_ctx, {
        workload: 'onedrive',
        owner_id: owner_id,
        operation: 'backup',
      });
      // Per-object retention carried by this run's context, not the bucket default: concurrent
      // runs on one tenant would overwrite each other's bucket setting (#551).
      const ctx = await attach_run_retention(tenant_ctx, options.object_lock_request);
      const stored_cursor = await this._cursors.load(ctx, owner_id);
      // Read before this run saves a manifest, which would become the head and hide a damaged one.
      const head = await this._manifests.find_latest_readable(ctx, owner_id);
      const folder_scope = normalize_folder_scope(options.folder_scope);
      // A changed scope or a cursor whose snapshot is gone reads in full, as `--full` does: either
      // would otherwise resume past changes no snapshot holds (issue #725).
      const resume = await select_resumable_cursor(ctx, ONEDRIVE_KEYS, owner_id, stored_cursor, {
        unit: 'drive',
        force_full: options.force_full === true,
        scope_changed: has_folder_scope_changed(stored_cursor, folder_scope),
      });
      const previous_cursor = resume.previous_cursor;
      const drives = await this._connector.list_drives(tenant_id, owner_id);
      // An empty list is what Graph answers for an owner whose OneDrive was never provisioned.
      // A revoked grant is a 403, which `list_drives` has already turned into the permission
      // error, so reading empty as a permission fault sent the operator to check a consent grant
      // that was fine (issue #369). Nothing to back up is a clean run with no snapshot.
      if (drives.length === 0) {
        logger.warn(`Owner ${owner_id} has no OneDrive drives; there is nothing to back up`);
      }
      progress = options.create_progress?.(
        drives.map((drive) => ({ name: drive.drive_name, total_items: 0 })),
      );

      const delta_link_by_drive: Record<string, string> = {
        ...(previous_cursor?.delta_link_by_drive ?? {}),
      };
      const tracking_state = {
        previous_path_by_file_id: {
          ...(previous_cursor?.previous_path_by_file_id ?? {}),
        },
        previous_name_by_file_id: {
          ...(previous_cursor?.previous_name_by_file_id ?? {}),
        },
        previous_etag_by_file_id: {
          ...(previous_cursor?.previous_etag_by_file_id ?? {}),
        },
        previous_kind_by_file_id: {
          ...(previous_cursor?.previous_kind_by_file_id ?? {}),
        },
      };

      await cleanup_stale_staging(ctx, owner_id);

      const manifest_created_at = new Date();
      const snapshot_id = `od-snap-${manifest_created_at.getTime()}-${randomBytes(3).toString('hex')}`;

      let total_versions_stored = 0;
      let total_versions_unavailable = 0;
      let total_versions_failed = 0;
      // Watermarks are read from the cursor even on a forced full run: they
      // record which historical versions Graph already handed over, not where
      // the delta stream stopped, and discarding them would re-download every
      // version of every file (issue #161).
      const versions = await load_run_version_collector(
        this._file_indexes,
        ctx,
        owner_id,
        resume.watermark_cursor,
      );
      const warnings: string[] =
        resume.outlived_warning === undefined ? [] : [resume.outlived_warning];
      const version_stats = {
        total_versions_stored,
        total_versions_unavailable,
        total_versions_failed,
      };
      const update_version_stats = (s: number, u: number, f: number): void => {
        total_versions_stored = s;
        total_versions_unavailable = u;
        total_versions_failed = f;
        version_stats.total_versions_stored = s;
        version_stats.total_versions_unavailable = u;
        version_stats.total_versions_failed = f;
      };

      const scan_result = await scan_all_drives(
        this._connector,
        drives,
        tenant_id,
        owner_id,
        snapshot_id,
        ctx,
        tracking_state,
        delta_link_by_drive,
        previous_cursor,
        options.force_full === true,
        versions,
        version_stats,
        update_version_stats,
        progress,
        options,
        folder_scope,
      );
      const skipped_manifests = await append_recrawl_tombstones(
        scan_result,
        () => this._manifests.list_readable_snapshots_by_owner(ctx, owner_id),
        (entry) =>
          folder_scope === undefined ||
          is_path_within_folder_scope(entry.parent_path, folder_scope),
        folder_scope !== undefined,
      );
      const processed = scan_result.items_processed;
      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'onedrive',
        phase: 'finalizing',
        processed,
      });
      scan_result.interrupted ||= options.should_interrupt?.() === true;

      const cursor: OneDriveDeltaCursor = {
        owner_id,
        delta_link_by_drive,
        ...tracking_state,
        version_watermark_by_file_id: versions.watermarks,
        failed_items: scan_result.failed_items,
        ...(folder_scope !== undefined ? { folder_scope } : {}),
        updated_at: new Date().toISOString(),
        // The snapshot this run writes, or the one it leaves as the newest when nothing changed.
        snapshot_id: await resolve_saved_cursor_binding(
          scan_result.entries.length > 0 ? snapshot_id : undefined,
          previous_cursor,
          async () => head,
        ),
      };

      // Version downloads that failed for an unexpected reason leave history out
      // of the snapshot: an error, not a warning, so the run exits EXIT_PARTIAL
      // like every other incomplete backup (issue #92).
      const errors = [...scan_result.errors, ...build_version_errors(total_versions_failed)];
      append_all(warnings, build_package_warnings(scan_result.package_report));
      // Files left un-backed-up are the run's headline problem: warn per item and
      // hold the run unhealthy until the ledger is empty.
      append_all(warnings, describe_failed_items(scan_result.failed_items));
      const healthy =
        !scan_result.interrupted &&
        errors.length === 0 &&
        Object.keys(scan_result.failed_items).length === 0;

      let result: OneDriveBackupResult;
      if (scan_result.entries.length === 0) {
        // Versions captured before the run lost its entries (a drive-level
        // failure discards them) are still on the wire and still watermarked:
        // the rows have to land before the cursor that tells the next run to
        // skip those versions, or that history is unreachable forever.
        lease.assert_held();
        await this._file_indexes.write_run_index(
          ctx,
          owner_id,
          snapshot_id,
          build_run_version_indexes(owner_id, snapshot_id, [], scan_result.version_rows),
        );
        lease.assert_held();
        await this._cursors.save(ctx, cursor);
        result = build_empty_result(
          owner_id,
          scan_result.drives_scanned,
          scan_result.files_stored,
          scan_result.files_deduplicated,
          scan_result.deleted_items,
          total_versions_stored,
          total_versions_unavailable,
          errors,
          warnings,
          scan_result.interrupted,
          healthy,
          true, // cursor_updated: the cursor was saved just above
          // `healthy`, not just `!interrupted`: a failed item still counts as processed, so a run
          // whose every file failed would otherwise read as `no_changes` when the truth is that
          // the changes did not land. An unhealthy run's reason is its errors.
          healthy
            ? await classify_empty_run({
                previous_kind_by_file_id: tracking_state.previous_kind_by_file_id,
                files_processed: scan_result.files_processed,
                find_latest_snapshot: async () => head,
              })
            : undefined,
        );
      } else {
        const snapshot = build_snapshot_manifest(
          tenant_id,
          owner_id,
          scan_result.entries,
          snapshot_id,
          manifest_created_at,
          options.owner_email,
          options.owner_display_name,
        );
        await persist_snapshot_backup(
          this._manifests,
          this._file_indexes,
          this._cursors,
          ctx,
          lease,
          owner_id,
          snapshot,
          scan_result.entries,
          cursor,
          scan_result.version_rows,
        );
        result = build_success_result(
          owner_id,
          snapshot,
          scan_result.drives_scanned,
          scan_result.files_stored,
          scan_result.files_deduplicated,
          scan_result.deleted_items,
          total_versions_stored,
          total_versions_unavailable,
          errors,
          warnings,
          scan_result.interrupted,
          healthy,
        );
      }

      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'onedrive',
        phase: scan_result.interrupted ? 'interrupted' : 'completed',
        processed,
      });
      return with_summary_unreadable_keys(
        result,
        merge_damaged_manifest_keys(head.unreadable_keys, skipped_manifests),
      );
    } finally {
      progress?.finish();
      await lease?.release();
      tenant_ctx.destroy();
    }
  }
}
