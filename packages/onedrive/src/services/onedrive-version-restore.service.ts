import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { inject, injectable } from 'inversify';
import type {
  DriveRestoredVersion,
  DriveVersionPlacement,
  DriveVersionRestoreOptions,
  DriveVersionRestoreResult,
  OneDriveConnector,
  OneDriveFileVersionIndexRepository,
  OneDriveVersionRestoreUseCase,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { download_and_decrypt_blob } from '@/services/onedrive-blob-restore';
import { ensure_onedrive_folder_path } from '@/services/onedrive-restore-folder-path';
import {
  select_versions_to_restore,
  type SelectedVersion,
} from '@/services/onedrive-version-selection';
import { build_restored_file_name, split_parent_path } from '@/services/onedrive-version-placement';

const SMALL_FILE_LIMIT = 4 * 1024 * 1024;

/**
 * Pushes stored OneDrive version bytes back into a live drive.
 *
 * Uploads the bytes Atlas holds rather than calling Graph's `restoreVersion`.
 * `restoreVersion` promotes a version the *service* still has, so it cannot
 * help once version history is trimmed or the file is gone, and its result
 * cannot be checked against the manifest checksum. Uploading a verified copy
 * is the only path that guarantees the operator gets what the backup recorded.
 */
@injectable()
export class OneDriveVersionRestoreService implements OneDriveVersionRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: OneDriveFileVersionIndexRepository,
  ) {}

  /** Restores one stored version, or every file's last version before a cutoff. */
  async restore_onedrive_version(
    tenant_id: string,
    owner_id: string,
    options: DriveVersionRestoreOptions,
  ): Promise<DriveVersionRestoreResult> {
    owner_id = normalize_owner_id(owner_id);
    const placement: DriveVersionPlacement = options.placement ?? 'copy';

    if (begin_operation_progress(options, 'restore', 'onedrive')) {
      finish_operation_progress(options, 'restore', 'onedrive', 0, 0);
      return empty_version_result(placement);
    }

    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const indexes = await this._indexes.list_by_owner(ctx, owner_id);
      const selection = select_versions_to_restore(indexes, options);

      // The version row records the drive it came from, so a version restore
      // needs no drive lookup and stays correct for an owner with several
      // drives, where "the first drive" would be a guess.
      const folder_ids_by_drive = new Map<string, Map<string, string>>();
      const restored: DriveRestoredVersion[] = [];
      const errors: string[] = [...selection.skipped];
      let files_skipped = selection.skipped.length;

      emit_operation_progress(options, {
        operation: 'restore',
        workload: 'onedrive',
        phase: 'processing',
        processed: 0,
        total: selection.selected.length,
      });

      for (const [index, candidate] of selection.selected.entries()) {
        if (options.should_interrupt?.() === true) break;
        const outcome = await this.restore_one_version(
          tenant_id,
          owner_id,
          ctx,
          folder_ids_by_drive,
          candidate,
          placement,
        );
        if (outcome.restored) restored.push(outcome.restored);
        else {
          files_skipped++;
          if (outcome.error) errors.push(outcome.error);
        }
        emit_operation_progress(options, {
          operation: 'restore',
          workload: 'onedrive',
          phase: 'processing',
          processed: index + 1,
          total: selection.selected.length,
          current: candidate.version.file_name,
        });
      }

      const interrupted = finish_operation_progress(
        options,
        'restore',
        'onedrive',
        restored.length + files_skipped,
        selection.selected.length + selection.skipped.length,
        restored.length + files_skipped < selection.selected.length,
      );

      return {
        files_restored: restored.length,
        files_skipped,
        restored,
        errors,
        interrupted,
        placement,
      };
    } finally {
      ctx.destroy();
    }
  }

  /** Fetches one stored version and uploads it, honouring the placement choice. */
  private async restore_one_version(
    tenant_id: string,
    owner_id: string,
    ctx: TenantContext,
    folder_ids_by_drive: Map<string, Map<string, string>>,
    candidate: SelectedVersion,
    placement: DriveVersionPlacement,
  ): Promise<{ restored?: DriveRestoredVersion; error?: string }> {
    const { version, original_path } = candidate;
    const drive_id = version.drive_id;
    try {
      const content = await download_and_decrypt_blob(ctx, version);
      if (!content) {
        return { error: `${original_path}: stored version could not be read or verified` };
      }

      // Folder ids are cached per drive: the same path exists in more than one
      // drive of the same owner and means a different folder in each.
      let folder_ids = folder_ids_by_drive.get(drive_id);
      if (!folder_ids) {
        folder_ids = new Map<string, string>([['/', 'root']]);
        folder_ids_by_drive.set(drive_id, folder_ids);
      }

      const { parent_path } = split_parent_path(original_path);
      const parent_id = await ensure_onedrive_folder_path(
        this._connector,
        tenant_id,
        owner_id,
        drive_id,
        parent_path,
        folder_ids,
      );
      if (!parent_id) {
        return { error: `${original_path}: could not resolve or create ${parent_path}` };
      }

      const file_name = build_restored_file_name(version, placement);
      // 'replace' on the original path becomes a new service version and
      // leaves the old current one in history; 'fail' guarantees a sibling
      // copy never silently overwrites something already there.
      const conflict = placement === 'in-place' ? 'replace' : 'fail';
      // Issue #242: without this the service stamps the restore time, and the
      // rolled-back file looks like it was authored during the incident.
      const file_system_info = version.last_modified_at
        ? { last_modified_at: version.last_modified_at }
        : undefined;
      const args = [
        tenant_id,
        owner_id,
        drive_id,
        parent_id,
        file_name,
        content,
        conflict,
        file_system_info,
      ] as const;
      if (content.length <= SMALL_FILE_LIMIT) {
        await this._connector.upload_small_file(...args);
      } else {
        await this._connector.upload_large_file(...args);
      }

      const restored_to = parent_path === '/' ? `/${file_name}` : `${parent_path}/${file_name}`;
      logger.info(
        `Restored version ${version.version_id ?? '(current-state row)'} to ${restored_to}`,
      );
      return {
        restored: {
          file_id: candidate.file_id,
          version_id: version.version_id,
          last_modified_at: version.last_modified_at,
          size_bytes: version.size_bytes,
          restored_to,
        },
      };
    } catch (err) {
      const msg = `${original_path}: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(`Skipped ${msg}`);
      return { error: msg };
    }
  }
}

function empty_version_result(placement: DriveVersionPlacement): DriveVersionRestoreResult {
  return {
    files_restored: 0,
    files_skipped: 0,
    restored: [],
    errors: [],
    interrupted: true,
    placement,
  };
}
