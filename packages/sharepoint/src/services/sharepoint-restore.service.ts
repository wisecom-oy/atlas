import { inject, injectable } from 'inversify';
import type {
  SharePointSiteConnector,
  SharePointManifestEntry,
  SharePointManifestRepository,
  SharePointRestoreOptions,
  SharePointRestoreResult,
  SharePointRestoreUseCase,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  download_and_decrypt,
  SharePointDecryptAuthError,
} from '@/services/sharepoint-restore-content';
import {
  describe_unresolved_destination,
  resolve_destination_library,
} from '@/services/sharepoint-restore-target';

const SMALL_FILE_LIMIT = 4 * 1024 * 1024;

@injectable()
export class SharePointRestoreService implements SharePointRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_CONNECTOR_TOKEN) private readonly _connector: SharePointSiteConnector,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
  ) {}

  /** Restores files from a snapshot back to the site's document libraries. */
  async restore_sharepoint(
    tenant_id: string,
    site_id: string,
    options: SharePointRestoreOptions,
  ): Promise<SharePointRestoreResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const manifest = await this._manifests.find_by_snapshot(ctx, site_id, options.snapshot_id);
      if (!manifest) {
        throw new Error(`Snapshot ${options.snapshot_id} not found for site ${site_id}`);
      }

      const target_site = options.target_site_id ?? site_id;
      const conflict = options.conflict_behavior ?? 'rename';
      const entries = this.filter_entries(manifest.entries, options.file_filter);

      // Entry drive ids belong to the source site, so a cross-site restore has to
      // re-point every upload at a library of the target site.
      const target_libraries =
        target_site === site_id
          ? []
          : await this._connector.list_document_libraries(tenant_id, target_site);
      if (target_site !== site_id && target_libraries.length === 0) {
        throw new Error(
          `Target site ${target_site} has no document libraries to restore into; ` +
            `refusing to fall back to the source site`,
        );
      }

      // Folder cache keyed by "drive_id:path" since entries span multiple document libraries
      const folder_ids = new Map<string, string>();
      let files_restored = 0;
      let files_skipped = 0;
      const errors: string[] = [];

      const restorable = [...entries].filter((e) => e.change_type !== 'deleted' && e.storage_key);

      for (const entry of restorable) {
        const destination =
          target_site === site_id
            ? { drive_id: entry.drive_id, drive_name: entry.library_name ?? '' }
            : resolve_destination_library(entry.library_name, target_libraries);

        if (!destination) {
          errors.push(
            describe_unresolved_destination(entry.file_name, entry.library_name, target_libraries),
          );
          files_skipped++;
          continue;
        }

        await this.restore_single_entry(
          tenant_id,
          target_site,
          destination.drive_id,
          conflict,
          ctx,
          entry,
          folder_ids,
          () => {
            files_restored++;
          },
          () => {
            files_skipped++;
          },
          errors,
        );
      }

      const unique_drive_folder_keys = new Set([...folder_ids.keys()].map((k) => k));
      const folders_created = Math.max(0, unique_drive_folder_keys.size);

      return {
        snapshot_id: options.snapshot_id,
        files_restored,
        folders_created,
        files_skipped,
        errors,
      };
    } finally {
      ctx.destroy();
    }
  }

  private async restore_single_entry(
    tenant_id: string,
    target_site: string,
    destination_drive_id: string,
    conflict: string,
    ctx: TenantContext,
    entry: SharePointManifestEntry,
    folder_ids: Map<string, string>,
    on_restored: () => void,
    on_skipped: () => void,
    errors: string[],
  ): Promise<void> {
    try {
      const parent_id = await this.ensure_folder_path(
        tenant_id,
        target_site,
        destination_drive_id,
        entry.parent_path,
        folder_ids,
      );

      if (parent_id === undefined) {
        errors.push(
          `Could not create folder path: ${entry.parent_path} in drive ${destination_drive_id}`,
        );
        on_skipped();
        return;
      }

      const content = await download_and_decrypt(ctx, entry);
      if (!content) {
        on_skipped();
        return;
      }

      if (content.length <= SMALL_FILE_LIMIT) {
        await this._connector.upload_small_file(
          tenant_id,
          target_site,
          destination_drive_id,
          parent_id,
          entry.file_name,
          content,
          conflict,
        );
      } else {
        await this._connector.upload_large_file(
          tenant_id,
          target_site,
          destination_drive_id,
          parent_id,
          entry.file_name,
          content,
          conflict,
        );
      }

      on_restored();
      logger.info(
        `Restored: ${entry.parent_path}/${entry.file_name} (drive: ${destination_drive_id})`,
      );
    } catch (err) {
      if (err instanceof SharePointDecryptAuthError) {
        const msg = `${entry.file_name}: ${err.message}`;
        errors.push(msg);
        on_skipped();
        logger.warn(`Skipped ${entry.file_name}: ${msg}`);
        return;
      }
      const msg = `${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      on_skipped();
      logger.warn(`Skipped ${entry.file_name}: ${msg}`);
    }
  }

  private filter_entries(
    entries: readonly SharePointManifestEntry[],
    file_filter?: string[],
  ): SharePointManifestEntry[] {
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
    site_id: string,
    drive_id: string,
    path: string,
    folder_ids: Map<string, string>,
  ): Promise<string | undefined> {
    const normalized = path.length === 0 || path === '.' ? '/' : path;
    const cache_key = `${drive_id}:${normalized}`;
    if (folder_ids.has(cache_key)) return folder_ids.get(cache_key)!;

    // Root always resolves to 'root'
    if (normalized === '/') {
      folder_ids.set(cache_key, 'root');
      return 'root';
    }

    const segments = normalized.split('/').filter(Boolean);
    let current_path = '';
    let parent_id = 'root';

    for (const segment of segments) {
      current_path = current_path ? `${current_path}/${segment}` : `/${segment}`;
      const segment_key = `${drive_id}:${current_path}`;
      if (folder_ids.has(segment_key)) {
        parent_id = folder_ids.get(segment_key)!;
        continue;
      }

      try {
        const folder_id = await this._connector.create_folder(
          tenant_id,
          site_id,
          drive_id,
          parent_id,
          segment,
        );
        folder_ids.set(segment_key, folder_id);
        parent_id = folder_id;
      } catch (err) {
        logger.warn(
          `Failed to create folder ${current_path} in drive ${drive_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }

    return parent_id;
  }
}
