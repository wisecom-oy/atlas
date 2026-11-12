import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  SharePointDeletionUseCase,
  TenantContextFactory,
  DeletionResult,
  ObjectStorage,
  OwnerLeases,
} from '@wisecom/atlas-types';
import { OWNER_LEASES_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import {
  delete_under_owner_lease,
  type LeasedDeletionDeps,
} from '@/services/deletion/shared/leased-deletion';
import { delete_scopes, delete_snapshot_manifest } from '@/services/deletion/shared/prefix-deleter';
import { abort_staging_uploads } from '@/services/deletion/shared/staging-upload-purge';
import { quarantined_copies_of } from '@/services/quarantine/stored-object-quarantine';

@injectable()
export class SharePointDeletionService implements SharePointDeletionUseCase {
  private readonly _deps: LeasedDeletionDeps;

  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) tenant_factory: TenantContextFactory,
    @inject(OWNER_LEASES_TOKEN) leases: OwnerLeases,
  ) {
    this._deps = { tenant_factory, leases };
  }

  /**
   * Deletes all backed-up SharePoint data for a single site.
   *
   * Staging is swept alongside the rest: a large-file upload interrupted before
   * its canonical copy leaves the file content parked there, and the backup path
   * only clears it opportunistically.
   */
  async delete_site_data(tenant_id: string, site_id: string): Promise<DeletionResult> {
    site_id = normalize_owner_id(site_id);
    return delete_under_owner_lease(this._deps, tenant_id, 'sharepoint', site_id, (storage) =>
      delete_all_objects_of(storage, site_id),
    );
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
    return delete_under_owner_lease(this._deps, tenant_id, 'sharepoint', site_id, (storage) =>
      delete_snapshot_manifest(
        storage,
        `sharepoint/manifests/${site_id}/${snapshot_id}.json`,
        'SharePoint',
        snapshot_id,
      ),
    );
  }
}

/** Deletes every object of one owner, staging uploads included. */
async function delete_all_objects_of(
  storage: ObjectStorage,
  site_id: string,
): Promise<DeletionResult> {
  const staging_prefix = `sharepoint/staging/${site_id}/`;
  const result = await delete_scopes(storage, [
    `sharepoint/manifests/${site_id}/`,
    `sharepoint/data/${site_id}/`,
    `sharepoint/index/${site_id}/`,
    `sharepoint/_meta/${site_id}/`,
    staging_prefix,
    ...quarantined_copies_of([`sharepoint/manifests/${site_id}/`, `sharepoint/index/${site_id}/`]),
  ]);
  // Deleting keys leaves an incomplete upload's parts behind, and no later run sweeps a site
  // nobody backs up any more (issue #345).
  await abort_staging_uploads(storage, staging_prefix);
  return result;
}
