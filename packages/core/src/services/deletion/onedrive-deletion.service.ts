import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type {
  OneDriveDeletionUseCase,
  OneDriveManifestRepository,
  OwnerLeasePort,
  TenantContextFactory,
  DeletionResult,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import {
  erase_leased_owner_scopes,
  run_owner_deletion,
  run_owner_erasure,
  type LeasedDeletionPorts,
} from '@/services/deletion/shared/leased-owner-deletion';
import { delete_newest_drive_snapshot } from '@/services/deletion/drive-snapshot-deleter';
import { abort_staging_uploads } from '@/services/deletion/shared/staging-upload-purge';
import { quarantined_copies_of } from '@/services/quarantine/stored-object-quarantine';

@injectable()
export class OneDriveDeletionService implements OneDriveDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  private get _ports(): LeasedDeletionPorts {
    return { tenant_factory: this._tenant_factory, leases: this._leases };
  }

  /**
   * Deletes all backed-up OneDrive data for a single owner.
   *
   * Staging is swept alongside the rest: a large-file upload interrupted before
   * its canonical copy leaves the file content parked there, and the backup path
   * only clears it opportunistically.
   *
   * Runs under the owner's lease, so it is refused with `OwnerBusyError` while a backup of the
   * owner is running (issue #623).
   */
  async delete_owner_data(tenant_id: string, owner_id: string): Promise<DeletionResult> {
    owner_id = normalize_owner_id(owner_id);
    const owner = { workload: 'onedrive', owner_id } as const;
    return run_owner_erasure(this._ports, tenant_id, owner, async (storage, lease) => {
      const staging_prefix = `onedrive/staging/${owner_id}/`;
      const result = await erase_leased_owner_scopes(storage, lease, [
        `onedrive/manifests/${owner_id}/`,
        `onedrive/data/${owner_id}/`,
        `onedrive/index/${owner_id}/`,
        `onedrive/_meta/${owner_id}/`,
        staging_prefix,
        ...quarantined_copies_of([
          `onedrive/manifests/${owner_id}/`,
          `onedrive/index/${owner_id}/`,
        ]),
      ]);
      // Deleting keys leaves an incomplete upload's parts behind, and no later run sweeps an owner
      // nobody backs up any more (issue #345).
      await abort_staging_uploads(storage, staging_prefix);
      return result;
    });
  }

  /**
   * Deletes the owner's newest OneDrive snapshot: its manifest, the delta cursor and its row in the
   * summary index. Blob objects
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
    const owner = { workload: 'onedrive', owner_id } as const;
    return run_owner_deletion(this._ports, tenant_id, owner, (ctx, lease) =>
      delete_newest_drive_snapshot(ctx, {
        lease,
        workload: 'onedrive',
        label: 'OneDrive',
        owner_id,
        snapshot_id,
        wording: { owner: 'OneDrive', records: 'files', delete_all_flag: '-o' },
        find_snapshot: () => this._manifests.find_by_snapshot(ctx, owner_id, snapshot_id),
        list_owner_manifests: () => this._manifests.list_snapshots_by_owner(ctx, owner_id),
        forget_summary: () => this._manifests.forget_snapshot_summary(ctx, owner_id, snapshot_id),
      }),
    );
  }
}
