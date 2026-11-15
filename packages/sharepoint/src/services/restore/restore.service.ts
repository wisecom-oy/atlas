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
import { inject, injectable } from 'inversify';
import type {
  SharePointSiteConnector,
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
import { resolve_entry_destination, type EntryRouting } from '@/services/restore/entry-routing';
import { restore_sharepoint_file_entry } from '@/services/restore/restore-file-entry';
import { restore_sharepoint_item_metadata } from '@/services/restore/restore-item-metadata';
import { with_unmatched_file_filters } from '@wisecom/atlas-drive/shared/entry-filter';
import { sharepoint_manifest_lookup } from '@/services/shared/manifest-lookup';
import { load_drive_chain_entries } from '@wisecom/atlas-drive/shared/manifest-chain';
import { select_restore_entries } from '@wisecom/atlas-drive/restore/restore-selection';
import type { ItemSharingRestoreDeps } from '@wisecom/atlas-drive/restore/item-sharing-restore';
import { SharingRestoreTally } from '@wisecom/atlas-drive/restore/sharing-restore-tally';
import { folder_colors_not_restored } from '@wisecom/atlas-drive/restore/folder-color-restore';
import { count_created_folders } from '@wisecom/atlas-drive/restore/folder-path';
import { empty_restore_result, is_run_interrupted } from '@/services/restore/restore-result';
import {
  assert_renameable,
  resolve_restore_root,
} from '@wisecom/atlas-core/services/shared/restore-destination';

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
    const selection = select_restore_entries(chain.entries, options.file_filter, options.rename_to);
    const restorable = selection.files;

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
    const sharing: ItemSharingRestoreDeps = {
      connector: this._connector,
      restore_permissions: options.restore_permissions === true,
      tally: new SharingRestoreTally(),
    };

    assert_renameable(options.rename_to, restorable.length);
    const restore_root = resolve_restore_root(options);
    const routing: EntryRouting = {
      cross_site,
      target_libraries,
      // Resolved once per source library rather than per file: the answer is the
      // same for every entry of a library, and an unresolvable one should be
      // reported once instead of once per skipped file.
      destination_by_source_drive: new Map<string, string | undefined>(),
      single_source_library: new Set(selection.entries.map((e) => e.drive_id)).size === 1,
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
      const destination_drive_id = resolve_entry_destination(entry, routing, errors);
      const outcome = destination_drive_id
        ? await restore_sharepoint_file_entry(
            this._connector,
            ctx,
            entry,
            {
              tenant_id,
              target_site,
              drive_id: destination_drive_id,
              conflict,
              folder_ids,
              root: restore_root,
              file_name: options.rename_to ?? entry.file_name,
            },
            errors,
            sharing,
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

    const files_done = files_restored + files_skipped === restorable.length;
    const metadata_interrupted =
      files_done &&
      (await restore_sharepoint_item_metadata(
        this._connector,
        selection.item_metadata,
        {
          tenant_id,
          target_site,
          restore_root,
          folder_ids,
          resolve_destination: (entry) => resolve_entry_destination(entry, routing, errors),
        },
        sharing,
        options,
        errors,
      ));

    const folders_created = count_created_folders(folder_ids);
    const interrupted = finish_operation_progress(
      options,
      'restore',
      'sharepoint',
      files_restored + files_skipped,
      restorable.length,
      !files_done || metadata_interrupted,
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
          ...sharing.tally.summary(),
          ...folder_colors_not_restored(selection.item_metadata),
        },
        selection.unmatched_filters,
      ),
      chain.unreadable_keys,
    );
  }
}
