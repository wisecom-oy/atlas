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
import {
  accumulate_version_stats,
  build_deleted_entry,
  build_empty_result,
  build_snapshot_manifest,
  build_stored_entry,
} from '@/services/sharepoint-backup-builders';
import {
  ensure_libraries_discovered,
  process_backup_file,
} from '@/services/sharepoint-backup-file-processor';
import { classify_change_type } from '@/services/sharepoint-change-classifier';
import { cleanup_stale_staging } from '@/services/sharepoint-large-file-pipeline';
import { sync_file_versions } from '@/services/sharepoint-version-sync';

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
    const previous_path_by_file_id: Record<string, string> = {
      ...(previous_cursor?.previous_path_by_file_id ?? {}),
    };
    const previous_name_by_file_id: Record<string, string> = {
      ...(previous_cursor?.previous_name_by_file_id ?? {}),
    };
    const previous_etag_by_file_id: Record<string, string> = {
      ...(previous_cursor?.previous_etag_by_file_id ?? {}),
    };
    const previous_kind_by_file_id: Record<string, 'file' | 'folder'> = {
      ...(previous_cursor?.previous_kind_by_file_id ?? {}),
    };

    await cleanup_stale_staging(ctx, site_id);

    const manifest_created_at = new Date();
    const snapshot_id = `sp-snap-${manifest_created_at.getTime()}-${randomBytes(3).toString('hex')}`;

    const entries: SharePointManifestEntry[] = [];
    let files_stored = 0;
    let files_deduplicated = 0;
    let deleted_items = 0;
    let total_versions_stored = 0;
    let total_versions_unavailable = 0;
    let total_versions_failed = 0;
    const errors: string[] = [];
    const warnings: string[] = [];

    const failed_drive_ids = new Set<string>();

    for (const library of libraries) {
      try {
        const prev_delta = options.force_full
          ? undefined
          : previous_cursor?.delta_link_by_drive[library.drive_id];
        const delta = await this._connector.fetch_delta(
          tenant_id,
          site_id,
          library.drive_id,
          prev_delta,
        );

        if (delta.reset_detected) {
          for (const [fid, kind] of Object.entries(previous_kind_by_file_id)) {
            if (kind === 'file') {
              delete previous_path_by_file_id[fid];
              delete previous_name_by_file_id[fid];
              delete previous_etag_by_file_id[fid];
            }
          }
        }

        let library_has_errors = false;
        const library_entries: SharePointManifestEntry[] = [];
        let library_files_stored = 0;
        let library_files_deduplicated = 0;
        let library_deleted_items = 0;

        for (const item of delta.items) {
          const effective_kind =
            item.deleted && item.kind === 'file' && previous_kind_by_file_id[item.item_id]
              ? previous_kind_by_file_id[item.item_id]
              : item.kind;
          if (effective_kind !== 'file') {
            if (!item.deleted) previous_kind_by_file_id[item.item_id] = item.kind;
            continue;
          }

          const change_type = classify_change_type(
            item,
            previous_path_by_file_id,
            previous_name_by_file_id,
            previous_etag_by_file_id,
          );
          if (!change_type) continue;

          if (item.deleted) {
            library_deleted_items++;
            library_entries.push(build_deleted_entry(item, change_type));
            continue;
          }

          const result = await process_backup_file(this._connector, item, site_id, ctx);
          if (!result) {
            library_has_errors = true;
            errors.push(`Failed to process file ${item.file_name} (${item.item_id})`);
            continue;
          }

          if (result.deduplicated) library_files_deduplicated++;
          if (result.stored) library_files_stored++;

          if (!result.deduplicated) {
            const version_result = await sync_file_versions(
              this._connector,
              item,
              site_id,
              snapshot_id,
              ctx,
              this._file_indexes,
            );
            accumulate_version_stats(
              version_result,
              { total_versions_stored, total_versions_unavailable, total_versions_failed },
              (s, u, f) => {
                total_versions_stored = s;
                total_versions_unavailable = u;
                total_versions_failed = f;
              },
            );
          }

          library_entries.push(
            build_stored_entry(item, result.storage_key, result.checksum, change_type),
          );
          previous_path_by_file_id[item.item_id] = item.parent_path;
          previous_name_by_file_id[item.item_id] = item.file_name;
          previous_kind_by_file_id[item.item_id] = 'file';
          if (item.etag) previous_etag_by_file_id[item.item_id] = item.etag;
        }

        if (!library_has_errors) {
          entries.push(...library_entries);
          files_stored += library_files_stored;
          files_deduplicated += library_files_deduplicated;
          deleted_items += library_deleted_items;
          delta_link_by_drive[library.drive_id] = delta.delta_link;

          await this._cursors.save(ctx, {
            site_id,
            delta_link_by_drive,
            previous_path_by_file_id,
            previous_name_by_file_id,
            previous_etag_by_file_id,
            previous_kind_by_file_id,
            updated_at: new Date().toISOString(),
          });
        } else {
          failed_drive_ids.add(library.drive_id);
          logger.warn(
            `Library ${library.drive_id}: discarding ${library_entries.length} entries due to errors`,
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(`Library ${library.drive_id} failed: ${reason}`);
        errors.push(`Library ${library.drive_name} (${library.drive_id}): ${reason}`);
        failed_drive_ids.add(library.drive_id);
      }
    }

    const cursor: SharePointDeltaCursor = {
      site_id,
      delta_link_by_drive,
      previous_path_by_file_id,
      previous_name_by_file_id,
      previous_etag_by_file_id,
      previous_kind_by_file_id,
      updated_at: new Date().toISOString(),
    };

    if (total_versions_failed > 0) {
      warnings.push(`${total_versions_failed} version download(s) failed unexpectedly`);
    }
    const healthy = errors.length === 0;

    if (entries.length === 0) {
      await this._cursors.save(ctx, cursor);
      return build_empty_result(
        site_id,
        libraries.length,
        files_stored,
        files_deduplicated,
        deleted_items,
        total_versions_stored,
        total_versions_unavailable,
        errors,
        warnings,
        healthy,
      );
    }

    const snapshot = build_snapshot_manifest(
      tenant_id,
      site_id,
      entries,
      snapshot_id,
      manifest_created_at,
      options.site_url,
      options.site_display_name,
    );
    await this._manifests.save(ctx, snapshot);

    for (const entry of entries) {
      await this._file_indexes.append_version(ctx, site_id, entry.file_id, {
        snapshot_id: snapshot.snapshot_id,
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

    await this._cursors.save(ctx, cursor);

    return {
      site_id,
      snapshot,
      summary: {
        libraries_scanned: libraries.length,
        files_changed: entries.length,
        files_stored,
        files_deduplicated,
        deleted_items,
        cursor_updated: true,
        snapshot_created: true,
        versions_stored: total_versions_stored,
        versions_unavailable: total_versions_unavailable,
        errors,
        warnings,
        healthy,
      },
    };
  }
}
