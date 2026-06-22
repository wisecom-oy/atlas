import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import type { MailboxConnector, MailFolder } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { StatusUseCase, MailboxStatusResult, FolderStatus } from '@wisecom/atlas-types';
import { assert_mailbox_exists } from '@wisecom/atlas-core/services/shared/mailbox-assertions';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';

@injectable()
export class MailboxStatusService implements StatusUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MAILBOX_CONNECTOR_TOKEN) private readonly _connector: MailboxConnector,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /** Peeks at Graph delta state to report whether a mailbox backup is current. */
  async check_mailbox_status(tenant_id: string, owner_id: string): Promise<MailboxStatusResult> {
    owner_id = owner_id.toLowerCase();
    await assert_mailbox_exists(this._connector, tenant_id, owner_id);

    const ctx = await this._tenant_factory.create(tenant_id);
    try {
      const previous = await this._manifests.find_latest_by_owner(ctx, owner_id);
      const saved_links = previous?.delta_links ?? {};

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
        last_backup_at: previous?.created_at ? new Date(previous.created_at) : undefined,
        last_snapshot_id: previous?.snapshot_id,
        total_folders: all_folders.length,
        folders: folder_statuses,
        is_up_to_date: total_pending === 0 && folder_statuses.every((f) => f.has_backup),
        total_pending_changes: total_pending,
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
      if (!delta_link) {
        results.push({
          folder_id: folder.folder_id,
          folder_name: folder.display_name,
          has_backup: false,
          pending_new: 0,
          pending_removed: 0,
          is_up_to_date: false,
        });
        continue;
      }

      try {
        const peek = await this.peek_folder_delta(tenant_id, owner_id, folder, delta_link);
        results.push(peek);
      } catch (err) {
        logger.debug(
          `Status peek failed for folder ${folder.display_name}: ${err instanceof Error ? err.message : err}`,
        );
        results.push({
          folder_id: folder.folder_id,
          folder_name: folder.display_name,
          has_backup: true,
          pending_new: 0,
          pending_removed: 0,
          is_up_to_date: false,
        });
      }
    }

    return results;
  }

  /** Fetches a single delta page to count pending changes without advancing state. */
  private async peek_folder_delta(
    tenant_id: string,
    owner_id: string,
    folder: MailFolder,
    delta_link: string,
  ): Promise<FolderStatus> {
    let pending_new = 0;
    let pending_removed = 0;

    const result = await this._connector.fetch_delta(
      tenant_id,
      owner_id,
      folder.folder_id,
      delta_link,
      (_page, _total, page_messages) => {
        pending_new += page_messages.length;
        return false;
      },
      1,
    );

    pending_removed = result.removed_ids.length;

    return {
      folder_id: folder.folder_id,
      folder_name: folder.display_name,
      has_backup: true,
      pending_new,
      pending_removed,
      is_up_to_date: pending_new === 0 && pending_removed === 0,
    };
  }
}
