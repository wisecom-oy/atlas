import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  SharePointDeletionUseCase,
  TenantContextFactory,
  DeletionResult,
} from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import { delete_scopes } from '@/services/deletion/shared/prefix-deleter';

@injectable()
export class SharePointDeletionService implements SharePointDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
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
    return delete_scopes(storage, [
      `sharepoint/manifests/${site_id}/`,
      `sharepoint/data/${site_id}/`,
      `sharepoint/index/${site_id}/`,
      `sharepoint/_meta/${site_id}/`,
      `sharepoint/staging/${site_id}/`,
    ]);
  }

  /**
   * Deletes a single SharePoint snapshot manifest. Blob objects are retained because
   * other snapshots may reference the same content-addressed keys.
   */
  async delete_snapshot(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    site_id = normalize_owner_id(site_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_scopes(storage, [`sharepoint/manifests/${site_id}/${snapshot_id}.json`]);
  }
}
