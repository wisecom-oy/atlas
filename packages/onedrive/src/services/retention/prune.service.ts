import { inject, injectable } from 'inversify';
import type {
  OneDriveFileVersionIndexRepository,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  OwnerLeasePort,
  SnapshotPruneOptions,
  SnapshotPruneResult,
  SnapshotPruneUseCase,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN,
  ONEDRIVE_MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { run_owner_deletion } from '@wisecom/atlas-core/services/deletion/shared/leased-owner-deletion';
import type { SnapshotPruneTarget } from '@wisecom/atlas-core/services/retention/snapshot-prune-target';
import { prune_owner_snapshots } from '@wisecom/atlas-core/services/retention/snapshot-prune-run';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';
import { drive_prune_target } from '@wisecom/atlas-drive/retention/drive-prune-target';
import { ONEDRIVE_KEYS } from '@/services/shared/storage-keys';

/** Removes a OneDrive owner's snapshots older than a cut-off and keeps the newer ones restorable. */
@injectable()
export class OneDriveSnapshotPruneService implements SnapshotPruneUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ONEDRIVE_MANIFEST_REPOSITORY_TOKEN)
    private readonly _manifests: OneDriveManifestRepository,
    @inject(ONEDRIVE_FILE_VERSION_INDEX_REPOSITORY_TOKEN)
    private readonly _indexes: OneDriveFileVersionIndexRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Prunes one owner under its lease, as a snapshot delete does, so it is refused with
   * `OwnerBusyError` while another operation holds it. See `prune_owner_snapshots`.
   */
  async prune_snapshots(
    tenant_id: string,
    owner_id: string,
    options: SnapshotPruneOptions,
  ): Promise<SnapshotPruneResult> {
    owner_id = normalize_owner_id(owner_id);
    return run_owner_deletion(
      { tenant_factory: this._tenant_factory, leases: this._leases },
      tenant_id,
      { workload: 'onedrive', owner_id: owner_id },
      (ctx, lease) => prune_owner_snapshots(this.prune_target(ctx, owner_id), lease, options),
    );
  }

  private prune_target(
    ctx: TenantContext,
    owner_id: string,
  ): SnapshotPruneTarget<OneDriveSnapshotManifest> {
    return drive_prune_target({
      label: 'OneDrive',
      ctx,
      keys: ONEDRIVE_KEYS,
      owner_id: owner_id,
      list_summaries: () => this._manifests.list_snapshot_summaries(ctx, owner_id),
      read_manifest: (key) => this._manifests.read_manifest_at(ctx, key),
      replace_with_baseline: (manifest, lease) =>
        this._manifests.replace_with_baseline(ctx, manifest, lease),
      forget_rows: (snapshot_ids, lease) =>
        this._manifests.forget_snapshot_summaries(ctx, owner_id, snapshot_ids, lease),
      list_indexes: () => this._indexes.list_readable_by_owner(ctx, owner_id),
      read_index_object: (key) => this._indexes.read_index_object_at(ctx, key),
      replace_run_index: (snapshot_id, indexes) =>
        this._indexes.replace_run_index(
          ctx,
          owner_id,
          snapshot_id,
          indexes.map((index) => ({ ...index, owner_id, versions: [...index.versions] })),
        ),
    });
  }
}
