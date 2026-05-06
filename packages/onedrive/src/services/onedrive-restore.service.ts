import { inject, injectable } from 'inversify';
import type {
  OneDriveConnector,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveRestoreOptions,
  OneDriveRestoreResult,
  OneDriveRestoreUseCase,
  TenantContext,
  TenantContextFactory,
} from '@atlas/types';
import {
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

const SMALL_FILE_LIMIT = 4 * 1024 * 1024;

@injectable()
export class OneDriveRestoreService implements OneDriveRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
  ) {}

  /** Restores files from a snapshot to the target user's OneDrive. */
  async restore_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveRestoreOptions,
  ): Promise<OneDriveRestoreResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const manifest = await this._manifests.find_by_snapshot(ctx, options.snapshot_id);
    if (!manifest) {
      throw new Error(`Snapshot ${options.snapshot_id} not found`);
    }

    const target_owner = options.target_owner_id ?? owner_id;
    const drives = await this._connector.list_drives(tenant_id, target_owner);
    const [primary_drive] = drives;
    if (!primary_drive) {
      throw new Error('No OneDrive drives found for target user');
    }
    const drive_id = primary_drive.drive_id;

    const entries = this.filter_entries(manifest.entries, options.file_filter);
    const folder_ids = new Map<string, string>();
    folder_ids.set('/', 'root');

    let files_restored = 0;
    let files_skipped = 0;
    const errors: string[] = [];

    const sorted_entries = [...entries].filter((e) => e.change_type !== 'deleted' && e.storage_key);

    for (const entry of sorted_entries) {
      try {
        const parent_id = await this.ensure_folder_path(
          tenant_id,
          target_owner,
          drive_id,
          entry.parent_path,
          folder_ids,
        );

        if (parent_id === undefined) {
          errors.push(`Could not create folder path: ${entry.parent_path}`);
          files_skipped++;
          continue;
        }

        const content = await this.download_and_decrypt(ctx, entry);
        if (!content) {
          files_skipped++;
          continue;
        }

        if (content.length <= SMALL_FILE_LIMIT) {
          await this._connector.upload_small_file(
            tenant_id,
            target_owner,
            drive_id,
            parent_id,
            entry.file_name,
            content,
          );
        } else {
          await this._connector.upload_large_file(
            tenant_id,
            target_owner,
            drive_id,
            parent_id,
            entry.file_name,
            content,
          );
        }

        files_restored++;
        logger.info(`Restored: ${entry.parent_path}/${entry.file_name}`);
      } catch (err) {
        const msg = `${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        files_skipped++;
        logger.warn(`Skipped ${entry.file_name}: ${msg}`);
      }
    }

    const folders_created = Math.max(0, folder_ids.size - 1);

    return {
      snapshot_id: options.snapshot_id,
      files_restored,
      folders_created,
      files_skipped,
      errors,
    };
  }

  private filter_entries(
    entries: readonly OneDriveManifestEntry[],
    file_filter?: string[],
  ): OneDriveManifestEntry[] {
    if (!file_filter || file_filter.length === 0) return [...entries];
    const filter_set = new Set(file_filter.map((f) => f.toLowerCase()));
    return entries.filter(
      (e) =>
        filter_set.has(e.file_id) ||
        filter_set.has(`${e.parent_path}/${e.file_name}`.toLowerCase()),
    );
  }

  private async ensure_folder_path(
    tenant_id: string,
    owner_id: string,
    drive_id: string,
    path: string,
    folder_ids: Map<string, string>,
  ): Promise<string | undefined> {
    const normalized = path.length === 0 || path === '.' ? '/' : path;
    if (folder_ids.has(normalized)) return folder_ids.get(normalized)!;

    const segments = normalized.split('/').filter(Boolean);
    let current_path = '';
    let parent_id = 'root';

    for (const segment of segments) {
      current_path = current_path ? `${current_path}/${segment}` : `/${segment}`;
      if (folder_ids.has(current_path)) {
        parent_id = folder_ids.get(current_path)!;
        continue;
      }

      try {
        const folder_id = await this._connector.create_folder(
          tenant_id,
          owner_id,
          drive_id,
          parent_id,
          segment,
        );
        folder_ids.set(current_path, folder_id);
        parent_id = folder_id;
      } catch (err) {
        logger.warn(
          `Failed to create folder ${current_path}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }

    return parent_id;
  }

  private async download_and_decrypt(
    ctx: TenantContext,
    entry: OneDriveManifestEntry,
  ): Promise<Buffer | undefined> {
    if (!entry.storage_key) return undefined;
    try {
      const encrypted = await ctx.storage.get(entry.storage_key);
      return ctx.decrypt(encrypted);
    } catch (err) {
      logger.warn(
        `Failed to decrypt ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }
}
