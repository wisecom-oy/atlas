import { randomBytes } from 'node:crypto';
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
  build_snapshot_manifest,
  build_success_result,
  persist_snapshot_backup,
} from '@/services/onedrive-backup-builders';
import { ensure_drives_discovered } from '@/services/onedrive-backup-file-processor';
import { scan_all_drives } from '@/services/onedrive-backup-drive-processor';
import { cleanup_stale_staging } from '@/services/onedrive-large-file-pipeline';
import { describe_failed_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';

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
      const previous_cursor =
        options.force_full === true ? undefined : await this._cursors.load(ctx, owner_id);
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
        this._file_indexes,
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
        version_stats,
        update_version_stats,
        progress,
      );

      const cursor: OneDriveDeltaCursor = {
        owner_id,
        delta_link_by_drive,
        ...tracking_state,
        failed_items: scan_result.failed_items,
        updated_at: new Date().toISOString(),
      };

      if (total_versions_failed > 0) {
        warnings.push(`${total_versions_failed} version download(s) failed unexpectedly`);
      }
      // Files left un-backed-up are the run's headline problem: warn per item and
      // hold the run unhealthy until the ledger is empty.
      warnings.push(...describe_failed_items(scan_result.failed_items));
      const healthy =
        scan_result.errors.length === 0 && Object.keys(scan_result.failed_items).length === 0;

      if (scan_result.entries.length === 0) {
        await this._cursors.save(ctx, cursor);
        return build_empty_result(
          owner_id,
          drives.length,
          scan_result.files_stored,
          scan_result.files_deduplicated,
          scan_result.deleted_items,
          total_versions_stored,
          total_versions_unavailable,
          scan_result.errors,
          warnings,
          healthy,
        );
      }

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
      );

      return build_success_result(
        owner_id,
        snapshot,
        drives.length,
        scan_result.files_stored,
        scan_result.files_deduplicated,
        scan_result.deleted_items,
        total_versions_stored,
        total_versions_unavailable,
        scan_result.errors,
        warnings,
        healthy,
      );
    } finally {
      progress?.finish();
      ctx.destroy();
    }
  }
}
