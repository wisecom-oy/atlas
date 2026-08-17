import type { ReplicationResult } from '@/domain/replication';
import type { StorageTarget } from '@/ports/replication/storage-target.port';

export interface OneDriveReplicationUseCase {
  /** Replicates a single sealed OneDrive snapshot to one or more targets. */
  replicate_owner(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]>;

  /** Replicates all unreplicated OneDrive snapshots for an owner. */
  replicate_all_owner_snapshots(
    tenant_id: string,
    owner_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]>;

  /** DR: recover a specific OneDrive snapshot from a replica. */
  rehydrate_owner_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult>;

  /** DR: recover all OneDrive snapshots for an owner from a replica. */
  rehydrate_owner(
    tenant_id: string,
    owner_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult>;

  /** DR: recover every OneDrive owner's snapshots from a replica. */
  rehydrate_all_owners(tenant_id: string, source: StorageTarget): Promise<ReplicationResult>;

  /** Replicates every unreplicated OneDrive snapshot for every owner in the tenant. */
  replicate_all_owners(tenant_id: string, targets: StorageTarget[]): Promise<ReplicationResult[]>;
}
