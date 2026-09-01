import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
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
} from '@/services/restore/restore-content';
import {
  describe_unresolved_destination,
  resolve_destination_library,
} from '@/services/restore/restore-target';
import { filter_sharepoint_entries } from '@/services/shared/entry-filter';
import {
  load_sharepoint_chain_entries,
  restorable_entries,
} from '@/services/shared/manifest-chain';
import { ensure_sharepoint_folder_path } from '@/services/restore/restore-folder-path';
import {
  assert_renameable,
  resolve_restore_root,
  restore_parent_path,
} from '@wisecom/atlas-core/services/shared/restore-destination';

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
    if (begin_operation_progress(options, 'restore', 'sharepoint')) {
      finish_operation_progress(options, 'restore', 'sharepoint', 0, 0);
      return empty_restore_result(options.snapshot_id);
    }
    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const chain = await load_sharepoint_chain_entries(
        this._manifests,
        ctx,
        site_id,
        options.snapshot_id,
      );

      const target_site = options.target_site_id ?? site_id;
      const conflict = options.conflict_behavior ?? 'rename';

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

      const restorable = filter_sharepoint_entries(
        restorable_entries(chain.entries),
        options.file_filter,
      );
      assert_renameable(options.rename_to, restorable.length);
      const restore_root = resolve_restore_root(options);
      const routing: EntryRouting = {
        cross_site,
        target_libraries,
        // Resolved once per source library rather than per file: the answer is the
        // same for every entry of a library, and an unresolvable one should be
        // reported once instead of once per skipped file.
        destination_by_source_drive: new Map<string, string | undefined>(),
        single_source_library: new Set(restorable.map((e) => e.drive_id)).size === 1,
      };
      emit_operation_progress(options, {
        operation: 'restore',
        workload: 'sharepoint',
        phase: 'processing',
        processed: 0,
        total: restorable.length,
      });

      for (const entry of restorable) {
        if (options.should_interrupt?.() === true) break;
        const destination_drive_id = this.resolve_entry_destination(entry, routing, errors);
        if (!destination_drive_id) {
          files_skipped++;
        } else {
          const outcome = await this.restore_single_entry(
            tenant_id,
            target_site,
            destination_drive_id,
            conflict,
            ctx,
            entry,
            folder_ids,
            errors,
            { root: restore_root, file_name: options.rename_to ?? entry.file_name },
          );
          if (outcome === 'restored') files_restored++;
          else files_skipped++;
        }
        emit_operation_progress(options, {
          operation: 'restore',
          workload: 'sharepoint',
          phase: 'processing',
          processed: files_restored + files_skipped,
          total: restorable.length,
          current: entry.file_name,
        });
      }

      const folders_created = folder_ids.size;
      const interrupted = finish_operation_progress(
        options,
        'restore',
        'sharepoint',
        files_restored + files_skipped,
        restorable.length,
        files_restored + files_skipped < restorable.length,
      );

      return {
        snapshot_id: options.snapshot_id,
        files_restored,
        folders_created,
        files_skipped,
        errors,
        interrupted,
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
    placement: { readonly root: string; readonly file_name: string },
  ): Promise<'restored' | 'skipped'> {
    const target_path = restore_parent_path(placement.root, entry.parent_path);
    try {
      const parent_id = await ensure_sharepoint_folder_path(
        this._connector,
        tenant_id,
        target_site,
        destination_drive_id,
        target_path,
        folder_ids,
      );

      if (parent_id === undefined) {
        errors.push(
          `Could not create folder path: ${target_path} in drive ${destination_drive_id}`,
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
          placement.file_name,
          content,
          conflict,
          entry.file_system_info,
        );
      } else {
        await this._connector.upload_large_file(
          tenant_id,
          target_site,
          destination_drive_id,
          parent_id,
          placement.file_name,
          content,
          conflict,
          entry.file_system_info,
        );
      }

      logger.info(
        `Restored: ${target_path}/${placement.file_name} (drive: ${destination_drive_id})`,
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
}

function empty_restore_result(snapshot_id: string): SharePointRestoreResult {
  return {
    snapshot_id,
    files_restored: 0,
    folders_created: 0,
    files_skipped: 0,
    errors: [],
    interrupted: true,
  };
}
