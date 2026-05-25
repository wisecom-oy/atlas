import { randomBytes } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  SharePointBackupOptions,
  SharePointBackupResult,
  SharePointBackupUseCase,
  SharePointSiteConnector,
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  SharePointFileVersionIndexRepository,
  SharePointManifestEntry,
  SharePointManifestRepository,
  TenantContextFactory,
} from '@atlas/types';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN,
  SHAREPOINT_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';
import { build_empty_result, build_snapshot_manifest } from '@/services/sharepoint-backup-builders';
import { ensure_libraries_discovered } from '@/services/sharepoint-backup-file-processor';
import {
  process_single_library,
  type FileTrackingState,
  type VersionStatsState,
} from '@/services/sharepoint-backup-library-processor';
import { cleanup_stale_staging } from '@/services/sharepoint-large-file-pipeline';

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
    const ctx = await this._tenant_factory.create(tenant_id);
    const previous_cursor =
      options.force_full === true ? undefined : await this._cursors.load(ctx, site_id);
    const libraries = await this._connector.list_document_libraries(tenant_id, site_id);
    ensure_libraries_discovered(libraries.length);

    const delta_link_by_drive: Record<string, string> = {
      ...(previous_cursor?.delta_link_by_drive ?? {}),
    };
    const tracking = this.build_tracking_state(previous_cursor);

    await cleanup_stale_staging(ctx, site_id);

    const manifest_created_at = new Date();
    const snapshot_id = `sp-snap-${manifest_created_at.getTime()}-${randomBytes(3).toString('hex')}`;
    const scan = await this.scan_all_libraries(
      tenant_id,
      site_id,
      snapshot_id,
      libraries,
      options,
      previous_cursor,
      tracking,
      delta_link_by_drive,
      ctx,
    );

    const cursor = this.build_cursor(site_id, delta_link_by_drive, tracking);
    const warnings = this.build_version_warnings(scan.version_stats);
    const healthy = scan.errors.length === 0;

    if (scan.entries.length === 0) {
      await this._cursors.save(ctx, cursor);
      return build_empty_result(
        site_id,
        libraries.length,
        scan.files_stored,
        scan.files_deduplicated,
        scan.deleted_items,
        scan.version_stats.total_versions_stored,
        scan.version_stats.total_versions_unavailable,
        scan.errors,
        warnings,
        healthy,
      );
    }

    return this.finalize_snapshot(
      ctx,
      tenant_id,
      site_id,
      scan,
      snapshot_id,
      manifest_created_at,
      libraries.length,
      options,
      cursor,
      warnings,
      healthy,
    );
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

  private async scan_all_libraries(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    libraries: Awaited<ReturnType<SharePointSiteConnector['list_document_libraries']>>,
    options: SharePointBackupOptions,
    previous_cursor: SharePointDeltaCursor | undefined,
    tracking: FileTrackingState,
    delta_link_by_drive: Record<string, string>,
    ctx: Awaited<ReturnType<TenantContextFactory['create']>>,
  ): Promise<{
    entries: SharePointManifestEntry[];
    files_stored: number;
    files_deduplicated: number;
    deleted_items: number;
    errors: string[];
    version_stats: VersionStatsState;
  }> {
    const entries: SharePointManifestEntry[] = [];
    let files_stored = 0;
    let files_deduplicated = 0;
    let deleted_items = 0;
    const version_stats: VersionStatsState = {
      total_versions_stored: 0,
      total_versions_unavailable: 0,
      total_versions_failed: 0,
    };
    const errors: string[] = [];

    for (const library of libraries) {
      try {
        const library_result = await process_single_library(
          this._connector,
          this._cursors,
          this._file_indexes,
          tenant_id,
          site_id,
          snapshot_id,
          library,
          options,
          previous_cursor,
          tracking,
          delta_link_by_drive,
          ctx,
          version_stats,
          errors,
        );

        if (library_result.had_errors) continue;

        entries.push(...library_result.entries);
        files_stored += library_result.files_stored;
        files_deduplicated += library_result.files_deduplicated;
        deleted_items += library_result.deleted_items;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(`Library ${library.drive_id} failed: ${reason}`);
        errors.push(`Library ${library.drive_name} (${library.drive_id}): ${reason}`);
      }
    }

    return { entries, files_stored, files_deduplicated, deleted_items, errors, version_stats };
  }

  private build_cursor(
    site_id: string,
    delta_link_by_drive: Record<string, string>,
    tracking: FileTrackingState,
  ): SharePointDeltaCursor {
    return {
      site_id,
      delta_link_by_drive,
      ...tracking,
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
    scan: {
      entries: SharePointManifestEntry[];
      files_stored: number;
      files_deduplicated: number;
      deleted_items: number;
      errors: string[];
      version_stats: VersionStatsState;
    },
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
    await this.append_version_indexes(ctx, site_id, scan.entries, snapshot.snapshot_id);

    await this._cursors.save(ctx, cursor);

    return {
      site_id,
      snapshot,
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

  private async append_version_indexes(
    ctx: Awaited<ReturnType<TenantContextFactory['create']>>,
    site_id: string,
    entries: SharePointManifestEntry[],
    snapshot_id: string,
  ): Promise<void> {
    for (const entry of entries) {
      await this._file_indexes.append_version(ctx, site_id, entry.file_id, {
        snapshot_id,
        backup_at: entry.backup_at,
        drive_id: entry.drive_id,
        file_name: entry.file_name,
        parent_path: entry.parent_path,
        size_bytes: entry.size_bytes,
        change_type: entry.change_type,
        ...(entry.web_url !== undefined ? { web_url: entry.web_url } : {}),
        ...(entry.storage_key !== undefined ? { storage_key: entry.storage_key } : {}),
        ...(entry.checksum !== undefined ? { checksum: entry.checksum } : {}),
        ...(entry.etag !== undefined ? { etag: entry.etag } : {}),
        ...(entry.last_modified_at !== undefined
          ? { last_modified_at: entry.last_modified_at }
          : {}),
      });
    }
  }
}
