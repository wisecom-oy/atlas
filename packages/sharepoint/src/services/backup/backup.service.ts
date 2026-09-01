import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { randomBytes } from 'node:crypto';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import type {
  SharePointBackupOptions,
  SharePointBackupResult,
  SharePointBackupUseCase,
  SharePointSiteConnector,
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  SharePointFileVersionIndexRepository,
  SharePointManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN,
  SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  describe_failed_items,
  type FailedItemLedger,
} from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  build_empty_result,
  build_package_warnings,
  build_run_version_indexes,
  build_snapshot_manifest,
  persist_snapshot_backup,
} from '@/services/backup/backup-builders';
import { ensure_libraries_discovered } from '@/services/backup/backup-file-processor';
import type {
  FileTrackingState,
  VersionStatsState,
} from '@/services/backup/library-item-processor';
import type { RunVersionCollector } from '@/services/versioning/version-sync';
import {
  scan_all_libraries,
  type SharePointLibraryScanResult,
} from '@/services/backup/backup-library-scan';
import { cleanup_stale_staging } from '@/services/backup/large-file-pipeline';

@injectable()
export class SharePointBackupService implements SharePointBackupUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_CONNECTOR_TOKEN) private readonly _connector: SharePointSiteConnector,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
    @inject(SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _file_indexes: SharePointFileVersionIndexRepository,
    @inject(SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: SharePointDeltaCursorRepository,
  ) {}

  /** Backs up changed SharePoint files and creates a snapshot only when data changed. */
  async backup_site(
    tenant_id: string,
    site_id: string,
    options: SharePointBackupOptions = {},
  ): Promise<SharePointBackupResult> {
    site_id = normalize_owner_id(site_id);
    if (begin_operation_progress(options, 'backup', 'sharepoint')) {
      finish_operation_progress(options, 'backup', 'sharepoint', 0, 0);
      return build_empty_result(site_id, 0, 0, 0, 0, 0, 0, [], [], false, true);
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
    try {
      const stored_cursor = await this._cursors.load(ctx, site_id);
      const previous_cursor = options.force_full === true ? undefined : stored_cursor;
      const libraries = await this._connector.list_document_libraries(tenant_id, site_id);
      ensure_libraries_discovered(libraries.length);
      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'sharepoint',
        phase: 'processing',
        processed: 0,
      });

      const delta_link_by_drive: Record<string, string> = {
        ...(previous_cursor?.delta_link_by_drive ?? {}),
      };
      const tracking = this.build_tracking_state(previous_cursor);

      await cleanup_stale_staging(ctx, site_id);

      const manifest_created_at = new Date();
      const snapshot_id = `sp-snap-${manifest_created_at.getTime()}-${randomBytes(3).toString('hex')}`;
      // Watermarks are read from the cursor even on a forced full run: they
      // record which historical versions Graph already handed over, not where
      // the delta stream stopped, and discarding them would re-download every
      // version of every file (issue #161).
      const versions = await this.load_run_version_collector(ctx, site_id, stored_cursor);
      const scan = await scan_all_libraries({
        connector: this._connector,
        cursors: this._cursors,
        versions,
        initial_failed_items: previous_cursor?.failed_items ?? {},
        tenant_id,
        site_id,
        snapshot_id,
        libraries,
        options,
        previous_cursor,
        tracking,
        delta_link_by_drive,
        ctx,
      });

      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'sharepoint',
        phase: 'finalizing',
        processed: scan.items_processed,
      });
      scan.interrupted ||= options.should_interrupt?.() === true;
      const cursor = this.build_cursor(
        site_id,
        delta_link_by_drive,
        tracking,
        scan.failed_items,
        versions.watermarks,
      );
      const warnings = [
        ...build_package_warnings(scan.package_reports),
        ...describe_failed_items(scan.failed_items),
      ];
      // Version downloads that failed for an unexpected reason leave history out
      // of the snapshot: an error, not a warning, so the run exits EXIT_PARTIAL
      // like every other incomplete backup (issue #92).
      const errors = [...scan.errors, ...this.build_version_errors(scan.version_stats)];
      const healthy =
        !scan.interrupted && errors.length === 0 && Object.keys(scan.failed_items).length === 0;

      let result: SharePointBackupResult;
      if (scan.entries.length === 0) {
        // Versions captured before the run lost its entries (a library-level
        // failure discards them) are still on the wire and still watermarked:
        // the rows have to land before the cursor that tells the next run to
        // skip those versions, or that history is unreachable forever.
        await this._file_indexes.write_run_index(
          ctx,
          site_id,
          snapshot_id,
          build_run_version_indexes(site_id, snapshot_id, [], scan.version_rows),
        );
        await this._cursors.save(ctx, cursor);
        result = build_empty_result(
          site_id,
          scan.libraries_scanned,
          scan.files_stored,
          scan.files_deduplicated,
          scan.deleted_items,
          scan.version_stats.total_versions_stored,
          scan.version_stats.total_versions_unavailable,
          errors,
          warnings,
          healthy,
          scan.interrupted,
        );
      } else {
        result = await this.finalize_snapshot(
          ctx,
          tenant_id,
          site_id,
          scan,
          snapshot_id,
          manifest_created_at,
          scan.libraries_scanned,
          options,
          cursor,
          errors,
          warnings,
          healthy,
        );
      }
      emit_operation_progress(options, {
        operation: 'backup',
        workload: 'sharepoint',
        phase: scan.interrupted ? 'interrupted' : 'completed',
        processed: scan.items_processed,
      });
      return result;
    } finally {
      ctx.destroy();
    }
  }

  private build_tracking_state(
    previous_cursor: SharePointDeltaCursor | undefined,
  ): FileTrackingState {
    return {
      previous_path_by_file_id: { ...(previous_cursor?.previous_path_by_file_id ?? {}) },
      previous_name_by_file_id: { ...(previous_cursor?.previous_name_by_file_id ?? {}) },
      previous_etag_by_file_id: { ...(previous_cursor?.previous_etag_by_file_id ?? {}) },
      previous_kind_by_file_id: { ...(previous_cursor?.previous_kind_by_file_id ?? {}) },
    };
  }

  private build_cursor(
    site_id: string,
    delta_link_by_drive: Record<string, string>,
    tracking: FileTrackingState,
    failed_items: FailedItemLedger,
    version_watermark_by_file_id: NonNullable<
      SharePointDeltaCursor['version_watermark_by_file_id']
    >,
  ): SharePointDeltaCursor {
    return {
      site_id,
      delta_link_by_drive,
      ...tracking,
      version_watermark_by_file_id,
      failed_items,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Builds the run's version bookkeeping from the delta cursor.
   *
   * Steady state costs nothing: the cursor is one object the run already reads,
   * and it carries the dedup watermarks. Only a cursor written before
   * watermarks existed falls back to scanning the version index, once, to seed
   * them; from the next run on that site is on the cheap path (issue #161).
   */
  private async load_run_version_collector(
    ctx: TenantContext,
    site_id: string,
    stored_cursor: SharePointDeltaCursor | undefined,
  ): Promise<RunVersionCollector> {
    const carried = stored_cursor?.version_watermark_by_file_id;
    if (carried) return { watermarks: { ...carried }, rows: new Map() };
    logger.info(`Seeding version dedup watermarks for ${site_id} from the version index`);
    return {
      watermarks: await this._file_indexes.load_version_watermarks(ctx, site_id),
      rows: new Map(),
    };
  }

  private build_version_errors(version_stats: VersionStatsState): string[] {
    if (version_stats.total_versions_failed === 0) return [];
    return [
      `${version_stats.total_versions_failed} version download(s) failed unexpectedly ` +
        `-- see the per-version reasons above; those versions are not in this snapshot`,
    ];
  }

  private async finalize_snapshot(
    ctx: Awaited<ReturnType<TenantContextFactory['create']>>,
    tenant_id: string,
    site_id: string,
    scan: SharePointLibraryScanResult,
    snapshot_id: string,
    manifest_created_at: Date,
    libraries_scanned: number,
    options: SharePointBackupOptions,
    cursor: SharePointDeltaCursor,
    errors: string[],
    warnings: string[],
    healthy: boolean,
  ): Promise<SharePointBackupResult> {
    const snapshot = build_snapshot_manifest(
      tenant_id,
      site_id,
      scan.entries,
      snapshot_id,
      manifest_created_at,
      options.site_url,
      options.site_display_name,
    );
    await persist_snapshot_backup(
      this._manifests,
      this._file_indexes,
      this._cursors,
      ctx,
      site_id,
      snapshot,
      scan.entries,
      cursor,
      scan.version_rows,
    );

    return {
      site_id,
      snapshot,
      interrupted: scan.interrupted,
      summary: {
        libraries_scanned,
        files_changed: scan.entries.length,
        files_stored: scan.files_stored,
        files_deduplicated: scan.files_deduplicated,
        deleted_items: scan.deleted_items,
        cursor_updated: true,
        snapshot_created: true,
        versions_stored: scan.version_stats.total_versions_stored,
        versions_unavailable: scan.version_stats.total_versions_unavailable,
        errors,
        warnings,
        healthy,
      },
    };
  }
}
