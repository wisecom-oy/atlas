import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  SharePointDocumentLibrary,
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

/** Per-run state deciding which library each entry is written to. */
interface EntryRouting {
  readonly cross_site: boolean;
  readonly target_libraries: readonly SharePointDocumentLibrary[];
  readonly single_source_library: boolean;
  /** Memoised destination per source library id; undefined means unresolvable. */
  readonly destination_by_source_drive: Map<string, string | undefined>;
}

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
    site_id = normalize_owner_id(site_id);
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
      const cross_site = target_site !== site_id;
      const target_libraries = cross_site
        ? await this._connector.list_document_libraries(tenant_id, target_site)
        : [];
      if (cross_site && target_libraries.length === 0) {
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
      const routing: EntryRouting = {
        cross_site,
        target_libraries,
        // Resolved once per source library rather than per file: the answer is the
        // same for every entry of a library, and an unresolvable one should be
        // reported once instead of once per skipped file.
        destination_by_source_drive: new Map<string, string | undefined>(),
        single_source_library: new Set(restorable.map((e) => e.drive_id)).size === 1,
      };

      for (const entry of restorable) {
        const destination_drive_id = this.resolve_entry_destination(entry, routing, errors);
        if (!destination_drive_id) {
          files_skipped++;
          continue;
        }

        const outcome = await this.restore_single_entry(
          tenant_id,
          target_site,
          destination_drive_id,
          conflict,
          ctx,
          entry,
          folder_ids,
          errors,
        );
        if (outcome === 'restored') files_restored++;
        else files_skipped++;
      }

      const folders_created = folder_ids.size;

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

  /**
   * Destination drive for one entry, or undefined when it cannot be placed.
   * Resolution is memoised per source library, so an unresolvable library is
   * reported once rather than once per file it holds.
   */
  private resolve_entry_destination(
    entry: SharePointManifestEntry,
    routing: EntryRouting,
    errors: string[],
  ): string | undefined {
    if (!routing.cross_site) {
      if (!entry.drive_id) {
        errors.push(`${entry.file_name}: manifest entry records no library; skipped`);
      }
      return entry.drive_id;
    }

    const { destination_by_source_drive, target_libraries, single_source_library } = routing;
    if (destination_by_source_drive.has(entry.drive_id)) {
      return destination_by_source_drive.get(entry.drive_id);
    }

    const destination = resolve_destination_library(
      entry.library_name,
      target_libraries,
      single_source_library,
    )?.drive_id;
    destination_by_source_drive.set(entry.drive_id, destination);
    if (!destination) {
      errors.push(
        describe_unresolved_destination(
          entry.library_name,
          target_libraries,
          single_source_library,
        ),
      );
    }
    return destination;
  }

  /** Restores one entry, reporting whether it landed or was skipped. */
  private async restore_single_entry(
    tenant_id: string,
    target_site: string,
    destination_drive_id: string,
    conflict: string,
    ctx: TenantContext,
    entry: SharePointManifestEntry,
    folder_ids: Map<string, string>,
    errors: string[],
  ): Promise<'restored' | 'skipped'> {
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
        return 'skipped';
      }

      const content = await download_and_decrypt(ctx, entry);
      if (!content) {
        // The specific cause is already logged; recording it here is what makes a
        // restore that verified nothing exit non-zero instead of reporting success.
        errors.push(`${entry.file_name}: content unavailable or failed verification; skipped`);
        return 'skipped';
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

      logger.info(
        `Restored: ${entry.parent_path}/${entry.file_name} (drive: ${destination_drive_id})`,
      );
      return 'restored';
    } catch (err) {
      const msg =
        err instanceof SharePointDecryptAuthError
          ? `${entry.file_name}: ${err.message}`
          : `${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      logger.warn(`Skipped ${entry.file_name}: ${msg}`);
      return 'skipped';
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
        filter_set.has(e.file_id.toLowerCase()) ||
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
