// Deliberately not shared with the OneDrive copy (#306): 194 differing lines of 496. The
// restore target differs in kind, a resolved site and library against an owner's drive, and
// so does the conflict handling around the restore root.
import { run_with_owner_lease_when_writable } from '@wisecom/atlas-core/services/lease/run-with-owner-lease';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { with_unreadable_keys } from '@wisecom/atlas-core/services/shared/unreadable-object-report';
import {
  begin_operation_progress,
  emit_operation_progress,
  finish_operation_progress,
} from '@wisecom/atlas-core/services/shared/operation-progress';
import { run_cancellable } from '@wisecom/atlas-core/services/shared/cancellable-run';
import { is_active_run_cancelled } from '@wisecom/atlas-core/services/shared/graph-request-context';
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
  OwnerLeasePort,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { read_restore_content } from '@wisecom/atlas-drive/restore/restore-content-read';
import {
  describe_unresolved_destination,
  resolve_destination_library,
} from '@/services/restore/restore-target';
import {
  select_drive_entries,
  with_unmatched_file_filters,
} from '@wisecom/atlas-drive/shared/entry-filter';
import { sharepoint_manifest_lookup } from '@/services/shared/manifest-lookup';
import {
  load_drive_chain_entries,
  restorable_entries,
} from '@wisecom/atlas-drive/shared/manifest-chain';
import { count_created_folders } from '@wisecom/atlas-drive/restore/folder-path';
import { empty_restore_result, is_run_interrupted } from '@/services/restore/restore-result';
import { ensure_sharepoint_folder_path } from '@/services/restore/restore-folder-path';
import {
  assert_renameable,
  resolve_restore_root,
  restore_parent_path,
} from '@wisecom/atlas-core/services/shared/restore-destination';

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
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /** Restores files from a snapshot back to the site's document libraries. */
  async restore_sharepoint(
    tenant_id: string,
    site_id: string,
    options: SharePointRestoreOptions,
  ): Promise<SharePointRestoreResult> {
    // Under the run's abort signal, so Ctrl+C also ends a Graph retry or throttle wait (#682).
    // A run cancelled before it could build its own result restored nothing.
    return run_cancellable(
      options,
      () => this.restore_snapshot_entries(tenant_id, normalize_owner_id(site_id), options),
      () => {
        finish_operation_progress(options, 'restore', 'sharepoint', 0, 0, true);
        return empty_restore_result(options.snapshot_id);
      },
    );
  }

  /** Restores every selected snapshot entry, stopping at an interrupt. */
  private async restore_snapshot_entries(
    tenant_id: string,
    site_id: string,
    options: SharePointRestoreOptions,
  ): Promise<SharePointRestoreResult> {
    if (begin_operation_progress(options, 'restore', 'sharepoint')) {
      finish_operation_progress(options, 'restore', 'sharepoint', 0, 0);
      return empty_restore_result(options.snapshot_id);
    }
    const tenant_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const scope = { workload: 'sharepoint', owner_id: site_id, operation: 'restore' } as const;
      return await run_with_owner_lease_when_writable(this._leases, tenant_ctx, scope, (ctx) =>
        this.restore_leased_entries(ctx, tenant_id, site_id, options),
      );
    } finally {
      tenant_ctx.destroy();
    }
  }

  /** Restores the selected entries while holding the site's lease. */
  private async restore_leased_entries(
    ctx: TenantContext,
    tenant_id: string,
    site_id: string,
    options: SharePointRestoreOptions,
  ): Promise<SharePointRestoreResult> {
    const chain = await load_drive_chain_entries(
      sharepoint_manifest_lookup(this._manifests),
      ctx,
      site_id,
      options.snapshot_id,
    );
    // Before the library listing, so a file filter that matches nothing fails without a Graph call.
    const selection = select_drive_entries(restorable_entries(chain.entries), options.file_filter);
    const restorable = selection.entries;

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
      if (is_run_interrupted(options)) break;
      const destination_drive_id = this.resolve_entry_destination(entry, routing, errors);
      const outcome = destination_drive_id
        ? await this.restore_single_entry(
            tenant_id,
            target_site,
            destination_drive_id,
            conflict,
            ctx,
            entry,
            folder_ids,
            errors,
            { root: restore_root, file_name: options.rename_to ?? entry.file_name },
          )
        : 'skipped';
      // Cut short by Ctrl+C: neither restored nor skipped, so the count reads as interrupted.
      if (outcome === 'cancelled') break;
      if (outcome === 'restored') files_restored++;
      else files_skipped++;
      emit_operation_progress(options, {
        operation: 'restore',
        workload: 'sharepoint',
        phase: 'processing',
        processed: files_restored + files_skipped,
        total: restorable.length,
        current: entry.file_name,
      });
    }

    const folders_created = count_created_folders(folder_ids);
    const interrupted = finish_operation_progress(
      options,
      'restore',
      'sharepoint',
      files_restored + files_skipped,
      restorable.length,
      files_restored + files_skipped < restorable.length,
    );

    return with_unreadable_keys(
      with_unmatched_file_filters(
        {
          snapshot_id: options.snapshot_id,
          files_restored,
          folders_created,
          files_skipped,
          errors,
          interrupted,
        },
        selection.unmatched_filters,
      ),
      chain.unreadable_keys,
    );
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
  ): Promise<'restored' | 'skipped' | 'cancelled'> {
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

      // A damaged object fails only its own file, and the run goes on (issue #712). Recording the
      // reason is what makes the run exit partial instead of reporting success.
      const read = await read_restore_content(ctx, entry);
      if (read.kind === 'unrestorable') {
        errors.push(`${entry.file_name}: ${read.reason}; skipped`);
        return 'skipped';
      }
      const content = read.content;

      // The blob reader streams anything past the small-file limit, so the shape it returned is
      // the upload to use.
      if (Buffer.isBuffer(content)) {
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
      // An upload cut short by Ctrl+C is the run stopping, not a failed file (issue #682).
      if (is_active_run_cancelled()) return 'cancelled';
      const msg = `${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      logger.warn(`Skipped ${entry.file_name}: ${msg}`);
      return 'skipped';
    }
  }
}
