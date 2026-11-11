import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import type { MailboxConnector, MailFolder } from '@wisecom/atlas-types';
import type { ManifestRepository, MailboxDeltaCursorRepository } from '@wisecom/atlas-types';
import type { StatusUseCase, MailboxStatusResult, FolderStatus } from '@wisecom/atlas-types';
import { assert_mailbox_exists } from '@wisecom/atlas-core/services/shared/mailbox-assertions';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  MAILBOX_DELTA_CURSOR_REPOSITORY_TOKEN,
} from '@wisecom/atlas-types';
import { peek_folder_or_record_error } from '@/services/status/folder-delta-peek';

/** The status row for a folder with no saved delta link. */
function never_backed_up_folder(folder: MailFolder): FolderStatus {
  return {
    folder_id: folder.folder_id,
    folder_name: folder.folder_path,
    has_backup: false,
    pending_new: 0,
    pending_removed: 0,
    pending_capped: false,
    is_up_to_date: false,
  };
}

@injectable()
export class MailboxStatusService implements StatusUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(MAILBOX_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: MailboxDeltaCursorRepository,
  ) {}

  /**
   * Peeks at Graph delta state to report whether a mailbox backup is current. Rejects with
   * `AuthError` or `MailboxNotLicensedError` when Graph refuses the peek.
   */
  async check_mailbox_status(tenant_id: string, owner_id: string): Promise<MailboxStatusResult> {
    owner_id = normalize_owner_id(owner_id);
    await assert_mailbox_exists(this._connector, tenant_id, owner_id);

    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      // A damaged head manifest is named in the result instead of failing the mailbox (#631).
      const latest = await this._manifests.find_latest_readable(ctx, owner_id);
      const previous = latest.manifest;
      // Legacy manifests carry mutable-ID delta links (issue #48); resuming
      // them with the immutable preference would mix ID formats, so peek
      // treats them as "no saved state" — every folder reports pending.
      // Delta links live in the cursor as of #370; a mailbox last backed up by an older release
      // still has them only in its head manifest.
      const cursor = await this._cursors.load(ctx, owner_id);
      const saved_links =
        cursor?.delta_links ??
        (previous?.id_format === 'immutable' ? (previous?.delta_links ?? {}) : {});

      const all_folders = await this._connector.list_mail_folders(tenant_id, owner_id);
      const folder_statuses = await this.peek_all_folders(
        tenant_id,
        owner_id,
        all_folders,
        saved_links,
      );

      const total_pending = folder_statuses.reduce(
        (sum, f) => sum + f.pending_new + f.pending_removed,
        0,
      );

      return {
        owner_id,
        last_backup_at: previous?.created_at,
        last_snapshot_id: previous?.snapshot_id,
        total_folders: all_folders.length,
        folders: folder_statuses,
        // Every folder's own flag, not the pending total: a folder whose peek failed reports no
        // pending changes and would otherwise read as up to date (issues #298, #630).
        is_up_to_date: folder_statuses.every((f) => f.is_up_to_date),
        total_pending_changes: total_pending,
        pending_capped: folder_statuses.some((f) => f.pending_capped),
        ...(latest.unreadable_keys.length > 0 ? { unreadable_keys: latest.unreadable_keys } : {}),
      };
    } finally {
      ctx.destroy();
    }
  }

  private async peek_all_folders(
    tenant_id: string,
    owner_id: string,
    folders: MailFolder[],
    saved_links: Record<string, string>,
  ): Promise<FolderStatus[]> {
    const results: FolderStatus[] = [];
    for (const folder of folders) {
      const delta_link = saved_links[folder.folder_id];
      results.push(
        delta_link
          ? await peek_folder_or_record_error(
              this._connector,
              tenant_id,
              owner_id,
              folder,
              delta_link,
            )
          : never_backed_up_folder(folder),
      );
    }
    return results;
  }
}
