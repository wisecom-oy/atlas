import { inject, injectable } from 'inversify';
import type {
  ManifestRepository,
  OwnerLeasePort,
  SnapshotPruneOptions,
  SnapshotPruneResult,
  SnapshotPruneUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { run_owner_deletion } from '@/services/deletion/shared/leased-owner-deletion';
import { outlook_prune_target } from '@/services/retention/outlook-prune-target';
import { prune_owner_snapshots } from '@/services/retention/snapshot-prune-run';
import { normalize_owner_id } from '@/services/shared/identifier-normalization';

/** Removes a mailbox's snapshots older than a cut-off and keeps the newer ones restorable. */
@injectable()
export class OutlookSnapshotPruneService implements SnapshotPruneUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  /**
   * Prunes one mailbox under its lease, as a snapshot delete does, so it is refused with
   * `OwnerBusyError` while a backup, restore or delete of the mailbox runs. A dry run takes the
   * lease too: what it reports must not change under it. See `prune_owner_snapshots`.
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
      { workload: 'outlook', owner_id },
      (ctx, lease) =>
        prune_owner_snapshots(outlook_prune_target(ctx, this._manifests, owner_id), lease, options),
    );
  }
}
