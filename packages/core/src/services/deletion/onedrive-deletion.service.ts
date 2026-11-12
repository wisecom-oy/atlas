import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  OneDriveDeletionUseCase,
  OneDriveManifestRepository,
  TenantContextFactory,
  DeletionResult,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { delete_scopes } from '@/services/deletion/shared/prefix-deleter';
import { delete_newest_drive_snapshot } from '@/services/deletion/drive-snapshot-deleter';
import { abort_staging_uploads } from '@/services/deletion/shared/staging-upload-purge';
import { quarantined_copies_of } from '@/services/quarantine/stored-object-quarantine';

@injectable()
export class OneDriveDeletionService implements OneDriveDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
  ) {}

  /**
   * Deletes all backed-up OneDrive data for a single owner.
   *
   * Staging is swept alongside the rest: a large-file upload interrupted before
   * its canonical copy leaves the file content parked there, and the backup path
   * only clears it opportunistically.
   */
  async delete_owner_data(tenant_id: string, owner_id: string): Promise<DeletionResult> {
    owner_id = normalize_owner_id(owner_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
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

  /**
   * Deletes the owner's newest OneDrive snapshot: its manifest and the delta cursor. Blob objects
   * are retained because other snapshots may reference the same content-addressed keys. Any other
   * snapshot is refused with `SnapshotNotNewestError`; see `delete_newest_drive_snapshot` (issue
   * #725). Reading the manifests to check the order needs the tenant key.
   */
  async delete_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return await delete_newest_drive_snapshot(ctx, {
        workload: 'onedrive',
        label: 'OneDrive',
        owner_id,
        snapshot_id,
        wording: { owner: 'OneDrive', records: 'files', delete_all_flag: '-o' },
        find_snapshot: () => this._manifests.find_by_snapshot(ctx, owner_id, snapshot_id),
        list_owner_manifests: () => this._manifests.list_snapshots_by_owner(ctx, owner_id),
      });
    } finally {
      ctx.destroy();
    }
  }
}
