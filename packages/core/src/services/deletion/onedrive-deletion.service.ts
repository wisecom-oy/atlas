import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  OneDriveDeletionUseCase,
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
export class OneDriveDeletionService implements OneDriveDeletionUseCase {
  private readonly _deps: LeasedDeletionDeps;

  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) tenant_factory: TenantContextFactory,
    @inject(OWNER_LEASES_TOKEN) leases: OwnerLeases,
  ) {
    this._deps = { tenant_factory, leases };
  }

  /**
   * Deletes all backed-up OneDrive data for a single owner.
   *
   * Staging is swept alongside the rest: a large-file upload interrupted before
   * its canonical copy leaves the file content parked there, and the backup path
   * only clears it opportunistically.
   */
  async delete_owner_data(tenant_id: string, owner_id: string): Promise<DeletionResult> {
    owner_id = normalize_owner_id(owner_id);
    return delete_under_owner_lease(this._deps, tenant_id, 'onedrive', owner_id, (storage) =>
      delete_all_objects_of(storage, owner_id),
    );
  }

  /**
   * Deletes a single OneDrive snapshot manifest. Blob objects are retained because
   * other snapshots may reference the same content-addressed keys.
   */
  async delete_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    owner_id = normalize_owner_id(owner_id);
    return delete_under_owner_lease(this._deps, tenant_id, 'onedrive', owner_id, (storage) =>
      delete_snapshot_manifest(
        storage,
        `onedrive/manifests/${owner_id}/${snapshot_id}.json`,
        'OneDrive',
        snapshot_id,
      ),
    );
  }
}

/** Deletes every object of one owner, staging uploads included. */
async function delete_all_objects_of(
  storage: ObjectStorage,
  owner_id: string,
): Promise<DeletionResult> {
  const staging_prefix = `onedrive/staging/${owner_id}/`;
  const result = await delete_scopes(storage, [
    `onedrive/manifests/${owner_id}/`,
    `onedrive/data/${owner_id}/`,
    `onedrive/index/${owner_id}/`,
    `onedrive/_meta/${owner_id}/`,
    staging_prefix,
    ...quarantined_copies_of([`onedrive/manifests/${owner_id}/`, `onedrive/index/${owner_id}/`]),
  ]);
  // Deleting keys leaves an incomplete upload's parts behind, and no later run sweeps an owner
  // nobody backs up any more (issue #345).
  await abort_staging_uploads(storage, staging_prefix);
  return result;
}
