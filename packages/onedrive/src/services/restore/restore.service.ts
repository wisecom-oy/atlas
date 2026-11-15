// Deliberately not shared with the SharePoint copy (#306): 194 differing lines of 496. The
// restore target differs in kind, an owner's drive against a resolved site and library, and
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
  OneDriveConnector,
  OneDriveManifestRepository,
  OneDriveRestoreOptions,
  OneDriveRestoreResult,
  OneDriveRestoreUseCase,
  TenantContext,
  OwnerLeasePort,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  NotFoundError,
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { append_all } from '@wisecom/atlas-core/utils/append-all';
import { with_unmatched_file_filters } from '@wisecom/atlas-drive/shared/entry-filter';
import { onedrive_manifest_lookup } from '@/services/shared/manifest-lookup';
import { build_drive_router } from '@/services/restore/drive-router';
import { load_drive_chain_entries } from '@wisecom/atlas-drive/shared/manifest-chain';
import { select_restore_entries } from '@wisecom/atlas-drive/restore/restore-selection';
import type { ItemSharingRestoreDeps } from '@wisecom/atlas-drive/restore/item-sharing-restore';
import { SharingRestoreTally } from '@wisecom/atlas-drive/restore/sharing-restore-tally';
import { restore_onedrive_file_entry } from '@/services/restore/restore-file-entry';
import { restore_onedrive_item_metadata } from '@/services/restore/restore-item-metadata';
import { empty_restore_result } from '@/services/restore/restore-result';
import {
  assert_renameable,
  resolve_restore_root,
} from '@wisecom/atlas-core/services/shared/restore-destination';
import { count_created_folders } from '@wisecom/atlas-drive/restore/folder-path';

@injectable()
export class OneDriveRestoreService implements OneDriveRestoreUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /** Restores files from a snapshot to the target user's OneDrive. */
  async restore_onedrive(
    tenant_id: string,
    owner_id: string,
    options: OneDriveRestoreOptions,
  ): Promise<OneDriveRestoreResult> {
    // Under the run's abort signal, so Ctrl+C also ends a Graph retry or throttle wait (#682).
    // A run cancelled before it could build its own result restored nothing.
    return run_cancellable(
      options,
      () => this.restore_snapshot_entries(tenant_id, normalize_owner_id(owner_id), options),
      () => {
        finish_operation_progress(options, 'restore', 'onedrive', 0, 0, true);
        return empty_restore_result(options.snapshot_id);
      },
    );
  }

  /** Restores every selected snapshot entry, stopping at an interrupt. */
  private async restore_snapshot_entries(
    tenant_id: string,
    owner_id: string,
    options: OneDriveRestoreOptions,
  ): Promise<OneDriveRestoreResult> {
    if (begin_operation_progress(options, 'restore', 'onedrive')) {
      finish_operation_progress(options, 'restore', 'onedrive', 0, 0);
      return empty_restore_result(options.snapshot_id);
    }
    const tenant_ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const scope = { workload: 'onedrive', owner_id: owner_id, operation: 'restore' } as const;
      return await run_with_owner_lease_when_writable(this._leases, tenant_ctx, scope, (ctx) =>
        this.restore_leased_entries(ctx, tenant_id, owner_id, options),
      );
    } finally {
      tenant_ctx.destroy();
    }
  }

  /** Restores the selected entries while holding the owner's lease. */
  private async restore_leased_entries(
    ctx: TenantContext,
    tenant_id: string,
    owner_id: string,
    options: OneDriveRestoreOptions,
  ): Promise<OneDriveRestoreResult> {
    const chain = await load_drive_chain_entries(
      onedrive_manifest_lookup(this._manifests),
      ctx,
      owner_id,
      options.snapshot_id,
    );
    // Before the drive listing, so a file filter that matches nothing fails without a Graph call.
    const selection = select_restore_entries(chain.entries, options.file_filter, options.rename_to);
    const restorable = selection.files;

    const target_owner = options.target_owner_id ?? owner_id;
    const drives = await this._connector.list_drives(tenant_id, target_owner);
    if (!drives[0]) {
      throw new NotFoundError('No OneDrive drives found for target user');
    }

    const conflict = options.conflict_behavior ?? 'rename';
    assert_renameable(options.rename_to, restorable.length);
    const restore_root = resolve_restore_root(options);
    const folder_ids = new Map<string, string>();
    const sharing: ItemSharingRestoreDeps = {
      connector: this._connector,
      restore_permissions: options.restore_permissions === true,
      tally: new SharingRestoreTally(),
    };

    let files_restored = 0;
    let files_skipped = 0;
    const errors: string[] = [];

    emit_operation_progress(options, {
      operation: 'restore',
      workload: 'onedrive',
      phase: 'processing',
      processed: 0,
      total: restorable.length,
    });

    // Each entry records the drive it came from, and an owner can have several. Resolving one
    // target drive per run and writing everything into it put the second drive's files into
    // the first drive, silently, since every upload succeeded against real folder ids. With
    // `--conflict replace` that overwrote same-path files (issue #361).
    const resolve_target_drive = build_drive_router(
      selection.entries,
      drives.map((drive) => drive.drive_id),
      owner_id,
      target_owner,
    );

    for (const entry of restorable) {
      if (options.should_interrupt?.() === true || options.abort_signal?.aborted === true) break;
      const routed = resolve_target_drive(entry);
      if (routed.error !== undefined) {
        files_skipped++;
        errors.push(routed.error);
        continue;
      }
      const result = await restore_onedrive_file_entry(
        this._connector,
        ctx,
        entry,
        {
          tenant_id,
          target_owner,
          drive_id: routed.drive_id,
          folder_ids,
          conflict,
          root: restore_root,
          file_name: options.rename_to ?? entry.file_name,
        },
        sharing,
      );
      // Cut short by Ctrl+C: neither restored nor skipped, so the count reads as interrupted.
      if (result.cancelled === true) break;
      if (result.restored) {
        files_restored++;
      } else {
        files_skipped++;
        if (result.error) errors.push(result.error);
      }
      emit_operation_progress(options, {
        operation: 'restore',
        workload: 'onedrive',
        phase: 'processing',
        processed: files_restored + files_skipped,
        total: restorable.length,
        current: entry.file_name,
      });
    }

    const files_done = files_restored + files_skipped === restorable.length;
    const metadata = await restore_onedrive_item_metadata(
      this._connector,
      files_done ? selection.item_metadata : [],
      { tenant_id, target_owner, restore_root, folder_ids, resolve_target_drive },
      sharing,
      options,
    );
    append_all(errors, metadata.errors);

    const folders_created = count_created_folders(folder_ids);
    const interrupted = finish_operation_progress(
      options,
      'restore',
      'onedrive',
      files_restored + files_skipped,
      restorable.length,
      !files_done || metadata.interrupted,
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
        },
        selection.unmatched_filters,
      ),
      chain.unreadable_keys,
    );
  }
}
