import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { peek_drive_statuses, summarize_drive_statuses } from '@wisecom/atlas-drive';
import { inject, injectable } from 'inversify';
import type {
  SharePointDeltaCursorRepository,
  SharePointManifestRepository,
  SharePointSiteConnector,
  SharePointStatusResult,
  SharePointStatusUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { explain_outlived_cursor } from '@wisecom/atlas-drive/shared/cursor-snapshot-binding';
import { SHAREPOINT_KEYS } from '@/services/shared/storage-keys';

/** Binds the shared drive status peek to the SharePoint connector, cursor and manifest lookup. */
@injectable()
export class SharePointStatusService implements SharePointStatusUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_CONNECTOR_TOKEN) private readonly _connector: SharePointSiteConnector,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
    @inject(SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN)
    private readonly _cursors: SharePointDeltaCursorRepository,
  ) {}

  /**
   * Peeks at Graph delta state and the failed-item ledger to report whether a SharePoint backup is
   * current. Rejects with `AuthError` when Graph refuses the peek.
   */
  async check_sharepoint_status(
    tenant_id: string,
    site_id: string,
  ): Promise<SharePointStatusResult> {
    site_id = normalize_owner_id(site_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const stored_cursor = await this._cursors.load(ctx, site_id);
      // The next backup does not resume a cursor that outlived its snapshot, so neither does the
      // peek: every library then reports as not backed up (issue #725).
      const outlived = await explain_outlived_cursor(ctx, SHAREPOINT_KEYS, site_id, stored_cursor);
      const previous_cursor = outlived === undefined ? stored_cursor : undefined;
      const failed_items = previous_cursor?.failed_items ?? {};
      // A damaged manifest is named in the result instead of failing the site (issue #631).
      const latest = await this._manifests.find_latest_readable(ctx, site_id);
      const previous_manifest = latest.manifest;
      const all_libraries = await this._connector.list_document_libraries(tenant_id, site_id);

      const library_statuses = await peek_drive_statuses({
        drives: all_libraries,
        delta_link_by_drive: previous_cursor?.delta_link_by_drive ?? {},
        previous_kind_by_file_id: previous_cursor?.previous_kind_by_file_id ?? {},
        failed_items,
        fetch_delta: (drive_id, delta_link) =>
          this._connector.fetch_delta(tenant_id, site_id, drive_id, delta_link),
        item_label: 'library',
      });

      return {
        site_id,
        last_backup_at: previous_manifest?.created_at
          ? new Date(previous_manifest.created_at)
          : undefined,
        last_snapshot_id: previous_manifest?.snapshot_id,
        total_libraries: all_libraries.length,
        libraries: library_statuses,
        ...summarize_drive_statuses(library_statuses, failed_items),
        ...(latest.unreadable_keys.length > 0 ? { unreadable_keys: latest.unreadable_keys } : {}),
      };
    } finally {
      ctx.destroy();
    }
  }
}
