import type { ReplicationResult } from '@/domain/replication';
import type { StorageTarget } from '@/ports/replication/storage-target.port';

export interface SharePointReplicationUseCase {
  /** Replicates a single sealed SharePoint snapshot to one or more targets. */
  replicate_site(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]>;

  /** Replicates all unreplicated SharePoint snapshots for a site. */
  replicate_all_site_snapshots(
    tenant_id: string,
    site_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]>;

  /** DR: recover a specific SharePoint snapshot from a replica. */
  rehydrate_site_snapshot(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult>;

  /** DR: recover all SharePoint snapshots for a site from a replica. */
  rehydrate_site(
    tenant_id: string,
    site_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult>;
}
