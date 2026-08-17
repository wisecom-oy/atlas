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
import {
  build_empty_result,
  build_package_warnings,
  build_snapshot_manifest,
} from '@/services/sharepoint-backup-builders';
import { ensure_libraries_discovered } from '@/services/sharepoint-backup-file-processor';
import type {
  FileTrackingState,
  VersionStatsState,
} from '@/services/sharepoint-library-item-processor';
import {
  scan_all_libraries,
  type SharePointLibraryScanResult,
} from '@/services/sharepoint-backup-library-scan';
import { cleanup_stale_staging } from '@/services/sharepoint-large-file-pipeline';
import { append_version_indexes } from '@/services/sharepoint-version-index-appender';

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
      const previous_cursor =
        options.force_full === true ? undefined : await this._cursors.load(ctx, site_id);
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
      const scan = await scan_all_libraries({
        connector: this._connector,
        cursors: this._cursors,
        file_indexes: this._file_indexes,
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
      const cursor = this.build_cursor(site_id, delta_link_by_drive, tracking, scan.failed_items);
      const warnings = [
        ...this.build_version_warnings(scan.version_stats),
        ...build_package_warnings(scan.package_reports),
        ...describe_failed_items(scan.failed_items),
      ];
      const healthy =
        !scan.interrupted &&
        scan.errors.length === 0 &&
        Object.keys(scan.failed_items).length === 0;

      let result: SharePointBackupResult;
      if (scan.entries.length === 0) {
        await this._cursors.save(ctx, cursor);
        result = build_empty_result(
          site_id,
          scan.libraries_scanned,
          scan.files_stored,
          scan.files_deduplicated,
          scan.deleted_items,
          scan.version_stats.total_versions_stored,
          scan.version_stats.total_versions_unavailable,
          scan.errors,
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
  ): SharePointDeltaCursor {
    return {
      site_id,
      delta_link_by_drive,
      ...tracking,
      failed_items,
      updated_at: new Date().toISOString(),
    };
  }

  private build_version_warnings(version_stats: VersionStatsState): string[] {
    if (version_stats.total_versions_failed === 0) return [];
    return [`${version_stats.total_versions_failed} version download(s) failed unexpectedly`];
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
    await this._manifests.save(ctx, snapshot);
    await append_version_indexes(
      this._file_indexes,
      ctx,
      site_id,
      scan.entries,
      snapshot.snapshot_id,
    );

    await this._cursors.save(ctx, cursor);

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
        errors: scan.errors,
        warnings,
        healthy,
      },
    };
  }
}
