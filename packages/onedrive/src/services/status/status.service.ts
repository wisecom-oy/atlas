import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { peek_drive_statuses, summarize_drive_statuses } from '@wisecom/atlas-drive';
import { explain_outlived_cursor } from '@wisecom/atlas-drive/shared/cursor-snapshot-binding';
import { inject, injectable } from 'inversify';
import type {
  TenantContextFactory,
  OneDriveConnector,
  OneDriveManifestRepository,
  OneDriveDeltaCursorRepository,
  OneDriveStatusUseCase,
  OneDriveStatusResult,
} from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  ONEDRIVE_CONNECTOR_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN,
} from '@wisecom/atlas-types';
import { ONEDRIVE_KEYS } from '@/services/shared/storage-keys';

/** Binds the shared drive status peek to the OneDrive connector, cursor and manifest lookup. */
@injectable()
export class OneDriveStatusService implements OneDriveStatusUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_CONNECTOR_TOKEN) private readonly _connector: OneDriveConnector,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: OneDriveDeltaCursorRepository,
  ) {}

  /**
   * Peeks at Graph delta state and the failed-item ledger to report whether a OneDrive backup is
   * current. Rejects with `AuthError` when Graph refuses the peek.
   */
  async check_onedrive_status(tenant_id: string, owner_id: string): Promise<OneDriveStatusResult> {
    owner_id = normalize_owner_id(owner_id);

    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const stored_cursor = await this._cursors.load(ctx, owner_id);
      // The next backup does not resume a cursor that outlived its snapshot, so neither does the
      // peek: every drive then reports as not backed up (issue #725).
      const outlived = await explain_outlived_cursor(ctx, ONEDRIVE_KEYS, owner_id, stored_cursor);
      const saved_cursor = outlived === undefined ? stored_cursor : undefined;
      const failed_items = saved_cursor?.failed_items ?? {};
      const all_drives = await this._connector.list_drives(tenant_id, owner_id);
      // A damaged manifest is named in the result instead of failing the owner (issue #631).
      const latest = await this._manifests.find_latest_readable(ctx, owner_id);
      const previous = latest.manifest;

      const drive_statuses = await peek_drive_statuses({
        drives: all_drives,
        delta_link_by_drive: saved_cursor?.delta_link_by_drive ?? {},
        previous_kind_by_file_id: saved_cursor?.previous_kind_by_file_id ?? {},
        failed_items,
        fetch_delta: (drive_id, delta_link) =>
          this._connector.fetch_delta(tenant_id, owner_id, drive_id, delta_link),
        item_label: 'drive',
      });

      return {
        owner_id,
        last_backup_at: previous?.created_at ? new Date(previous.created_at) : undefined,
        last_snapshot_id: previous?.snapshot_id,
        total_drives: all_drives.length,
        drives: drive_statuses,
        ...summarize_drive_statuses(drive_statuses, failed_items),
        ...(latest.unreadable_keys.length > 0 ? { unreadable_keys: latest.unreadable_keys } : {}),
      };
    } finally {
      ctx.destroy();
    }
  }
}
