import { inject, injectable } from 'inversify';
import type {
  SharePointDeltaCursorRepository,
  SharePointDocumentLibrary,
  SharePointLibraryStatus,
  SharePointManifestRepository,
  SharePointSiteConnector,
  SharePointStatusResult,
  SharePointStatusUseCase,
  TenantContextFactory,
} from '@atlas/types';
import {
  SHAREPOINT_CONNECTOR_TOKEN,
  SHAREPOINT_DELTA_CURSOR_REPOSITORY_TOKEN,
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import { logger } from '@atlas/core/utils/logger';

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

  /** Peeks at Graph delta state to report whether a SharePoint backup is current. */
  async check_sharepoint_status(
    tenant_id: string,
    site_id: string,
  ): Promise<SharePointStatusResult> {
    const ctx = await this._tenant_factory.create(tenant_id);
    const previous_cursor = await this._cursors.load(ctx, site_id);
    const saved_links = previous_cursor?.delta_link_by_drive ?? {};

    const previous_manifest = await this._manifests.find_latest_by_site(ctx, site_id);
    const all_libraries = await this._connector.list_document_libraries(tenant_id, site_id);
    const library_statuses = await this.peek_all_libraries(
      tenant_id,
      site_id,
      all_libraries,
      saved_links,
    );

    const total_pending = library_statuses.reduce((sum, lib) => sum + lib.pending_changes, 0);

    return {
      site_id,
      last_backup_at: previous_manifest?.created_at
        ? new Date(previous_manifest.created_at)
        : undefined,
      last_snapshot_id: previous_manifest?.snapshot_id,
      total_libraries: all_libraries.length,
      libraries: library_statuses,
      is_up_to_date: total_pending === 0 && library_statuses.every((lib) => lib.has_backup),
      total_pending_changes: total_pending,
    };
  }

  private async peek_all_libraries(
    tenant_id: string,
    site_id: string,
    libraries: SharePointDocumentLibrary[],
    saved_links: Record<string, string>,
  ): Promise<SharePointLibraryStatus[]> {
    const results: SharePointLibraryStatus[] = [];

    for (const library of libraries) {
      const delta_link = saved_links[library.drive_id];
      if (!delta_link) {
        results.push({
          drive_id: library.drive_id,
          drive_name: library.drive_name,
          has_backup: false,
          pending_changes: 0,
          is_up_to_date: false,
        });
        continue;
      }

      try {
        const peek = await this.peek_library_delta(tenant_id, site_id, library, delta_link);
        results.push(peek);
      } catch (err) {
        logger.debug(
          `Status peek failed for library ${library.drive_name}: ${err instanceof Error ? err.message : err}`,
        );
        results.push({
          drive_id: library.drive_id,
          drive_name: library.drive_name,
          has_backup: true,
          pending_changes: 0,
          is_up_to_date: false,
        });
      }
    }

    return results;
  }

  /** Fetches delta changes to count pending items without advancing persisted cursor state. */
  private async peek_library_delta(
    tenant_id: string,
    site_id: string,
    library: SharePointDocumentLibrary,
    delta_link: string,
  ): Promise<SharePointLibraryStatus> {
    const result = await this._connector.fetch_delta(
      tenant_id,
      site_id,
      library.drive_id,
      delta_link,
    );
    const pending_changes = result.items.length;

    return {
      drive_id: library.drive_id,
      drive_name: library.drive_name,
      has_backup: true,
      pending_changes,
      is_up_to_date: pending_changes === 0,
    };
  }
}
