import { inject, injectable } from 'inversify';
import type {
  OneDriveDeletionUseCase,
  TenantContextFactory,
  DeletionResult,
} from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import { delete_scopes } from '@/services/deletion/shared/prefix-deleter';

@injectable()
export class OneDriveDeletionService implements OneDriveDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
  ) {}

  /**
   * Deletes all backed-up OneDrive data for a single owner.
   *
   * Staging is swept alongside the rest: a large-file upload interrupted before
   * its canonical copy leaves the file content parked there, and the backup path
   * only clears it opportunistically.
   */
  async delete_owner_data(tenant_id: string, owner_id: string): Promise<DeletionResult> {
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_scopes(storage, [
      `onedrive/manifests/${owner_id}/`,
      `onedrive/data/${owner_id}/`,
      `onedrive/index/${owner_id}/`,
      `onedrive/_meta/${owner_id}/`,
      `onedrive/staging/${owner_id}/`,
    ]);
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
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_scopes(storage, [`onedrive/manifests/${owner_id}/${snapshot_id}.json`]);
  }
}
