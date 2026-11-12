import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  SharePointDeletionUseCase,
  SharePointManifestRepository,
  TenantContextFactory,
  DeletionResult,
} from '@wisecom/atlas-types';
import {
  SHAREPOINT_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { delete_scopes } from '@/services/deletion/shared/prefix-deleter';
import { delete_newest_drive_snapshot } from '@/services/deletion/drive-snapshot-deleter';
import { abort_staging_uploads } from '@/services/deletion/shared/staging-upload-purge';
import { quarantined_copies_of } from '@/services/quarantine/stored-object-quarantine';

@injectable()
export class SharePointDeletionService implements SharePointDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(SHAREPOINT_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: SharePointManifestRepository,
  ) {}

  /**
   * Deletes all backed-up SharePoint data for a single site.
   *
   * Staging is swept alongside the rest: a large-file upload interrupted before
   * its canonical copy leaves the file content parked there, and the backup path
   * only clears it opportunistically.
   */
  async delete_site_data(tenant_id: string, site_id: string): Promise<DeletionResult> {
    site_id = normalize_owner_id(site_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    const staging_prefix = `sharepoint/staging/${site_id}/`;
    const result = await delete_scopes(storage, [
      `sharepoint/manifests/${site_id}/`,
      `sharepoint/data/${site_id}/`,
      `sharepoint/index/${site_id}/`,
      `sharepoint/_meta/${site_id}/`,
      staging_prefix,
      ...quarantined_copies_of([
        `sharepoint/manifests/${site_id}/`,
        `sharepoint/index/${site_id}/`,
      ]),
    ]);
    // Deleting keys leaves an incomplete upload's parts behind, and no later run sweeps a site
    // nobody backs up any more (issue #345).
    await abort_staging_uploads(storage, staging_prefix);
    return result;
  }

  /**
   * Deletes the site's newest SharePoint snapshot: its manifest and the delta cursor. Blob objects
   * are retained because other snapshots may reference the same content-addressed keys. Any other
   * snapshot is refused with `SnapshotNotNewestError`; see `delete_newest_drive_snapshot` (issue
   * #725). Reading the manifests to check the order needs the tenant key.
   */
  async delete_snapshot(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    site_id = normalize_owner_id(site_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return await delete_newest_drive_snapshot(ctx, {
        workload: 'sharepoint',
        label: 'SharePoint',
        owner_id: site_id,
        snapshot_id,
        wording: { owner: 'site', records: 'files', delete_all_flag: '--site' },
        find_snapshot: () => this._manifests.find_by_snapshot(ctx, site_id, snapshot_id),
        list_owner_manifests: () => this._manifests.list_snapshots_by_site(ctx, site_id),
      });
    } finally {
      ctx.destroy();
    }
  }
}
