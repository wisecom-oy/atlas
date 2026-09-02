import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { randomBytes } from 'node:crypto';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import type {
  BackupProgressReporter,
  OneDriveBackupOptions,
  OneDriveBackupResult,
  OneDriveBackupUseCase,
  OneDriveConnector,
  OneDriveDeltaCursor,
  OneDriveDeltaCursorRepository,
  OneDriveFileVersionIndexRepository,
  OneDriveManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN,
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  build_empty_result,
  build_run_version_indexes,
  build_snapshot_manifest,
  build_success_result,
  persist_snapshot_backup,
} from '@/services/backup/backup-builders';
import type { RunVersionCollector } from '@/services/versioning/version-sync';
import { ensure_drives_discovered } from '@/services/backup/backup-file-processor';
import { scan_all_drives } from '@/services/backup/backup-drive-processor';
import type { PackageReportTotals } from '@/services/backup/package-report';
import { cleanup_stale_staging } from '@/services/backup/large-file-pipeline';
import { normalize_folder_scope } from '@/services/backup/folder-scope';
import { describe_failed_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { logger } from '@wisecom/atlas-core/utils/logger';

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
  ) {}

  /** Backs up changed OneDrive files and creates a snapshot only when data changed. */
  async backup_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveBackupOptions = {},
  ): Promise<OneDriveBackupResult> {
    owner_id = normalize_owner_id(owner_id);
    if (begin_operation_progress(options, 'backup', 'onedrive')) {
      finish_operation_progress(options, 'backup', 'onedrive', 0, 0);
      return build_empty_result(owner_id, 0, 0, 0, 0, 0, 0, [], [], true, false);
    }
    const ctx = await this._tenant_factory.create(tenant_id);
    if (options.object_lock_request?.retention_days) {
      // Bucket default retention: every new object version (files, versions,
      // manifests, cursors) inherits the lock - no write path can forget it.
      await ctx.storage.apply_default_retention(
        options.object_lock_request.mode ?? 'GOVERNANCE',
        options.object_lock_request.retention_days,
      );
    }
    let progress: BackupProgressReporter | undefined;
    try {
      const stored_cursor = await this._cursors.load(ctx, owner_id);
      const folder_scope = normalize_folder_scope(options.folder_scope);
      // A delta link records how far the drive was consumed, not how far the scope was, so
      // resuming one under a different scope would skip changes the previous run filtered out.
      const scope_changed = (stored_cursor?.folder_scope ?? undefined) !== folder_scope;
      if (scope_changed && stored_cursor !== undefined) {
        logger.info(
          `Folder scope changed (${stored_cursor.folder_scope ?? 'whole drive'} -> ` +
            `${folder_scope ?? 'whole drive'}); re-crawling instead of resuming the delta link`,
        );
      }
      const previous_cursor =
        options.force_full === true || scope_changed ? undefined : stored_cursor;
      const drives = await this._connector.list_drives(tenant_id, owner_id);
      ensure_drives_discovered(drives.length);
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
      const versions = await this.load_run_version_collector(ctx, owner_id, stored_cursor);
      const warnings: string[] = [];
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
        this._cursors,
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
      };

      // Version downloads that failed for an unexpected reason leave history out
      // of the snapshot: an error, not a warning, so the run exits EXIT_PARTIAL
      // like every other incomplete backup (issue #92).
      const errors = [...scan_result.errors];
      if (total_versions_failed > 0) {
        errors.push(
          `${total_versions_failed} version download(s) failed unexpectedly ` +
            `-- see the per-version reasons above; those versions are not in this snapshot`,
        );
      }
      warnings.push(...build_package_warnings(scan_result.package_report));
      // Files left un-backed-up are the run's headline problem: warn per item and
      // hold the run unhealthy until the ledger is empty.
      warnings.push(...describe_failed_items(scan_result.failed_items));
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
        await this._file_indexes.write_run_index(
          ctx,
          owner_id,
          snapshot_id,
          build_run_version_indexes(owner_id, snapshot_id, [], scan_result.version_rows),
        );
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
      return result;
    } finally {
      progress?.finish();
      ctx.destroy();
    }
  }

  /**
   * Builds the run's version bookkeeping from the delta cursor.
   *
   * Steady state costs nothing: the cursor is one object the run already reads,
   * and it carries the dedup watermarks. Only a cursor written before
   * watermarks existed falls back to scanning the version index, once, to seed
   * them; from the next run on that owner is on the cheap path (issue #161).
   */
  private async load_run_version_collector(
    ctx: TenantContext,
    owner_id: string,
    stored_cursor: OneDriveDeltaCursor | undefined,
  ): Promise<RunVersionCollector> {
    const carried = stored_cursor?.version_watermark_by_file_id;
    if (carried) return { watermarks: { ...carried }, rows: new Map() };
    logger.info(`Seeding version dedup watermarks for ${owner_id} from the version index`);
    return {
      watermarks: await this._file_indexes.load_version_watermarks(ctx, owner_id),
      rows: new Map(),
    };
  }
}

/** Renders OneNote accounting as backup warnings: one summary line, then any incomplete notebooks. */
function build_package_warnings(report: PackageReportTotals): string[] {
  if (report.notebooks_detected === 0) return [];
  return [
    `OneNote notebooks detected: ${report.notebooks_detected} ` +
      `(${report.section_files_backed_up} section file(s) backed up as ordinary files).`,
    ...report.warnings,
  ];
}
