import type { ReplicationResult, ReplicationStatusRecord } from '@/domain/replication';
import type { StorageTarget } from '@/ports/replication/storage-target.port';

export interface ReplicationUseCase {
  /** Replicates a single sealed snapshot to one or more targets. */
  replicate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]>;

  /** Replicates all unreplicated snapshots for a mailbox to one or more targets. */
  replicate_mailbox(
    tenant_id: string,
    owner_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]>;

  /** DR: recover a specific snapshot from a designated replica to primary. */
  rehydrate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult>;

  /** DR: recover all snapshots for a mailbox from a designated replica. */
  rehydrate_mailbox(
    tenant_id: string,
    owner_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult>;

  /** DR: recover all mailboxes and snapshots from a designated replica. */
  rehydrate_tenant(tenant_id: string, source: StorageTarget): Promise<ReplicationResult>;

  /** Queries durable replication status records, optionally filtered by snapshot. */
  get_replication_status(
    tenant_id: string,
    snapshot_id?: string,
  ): Promise<ReplicationStatusRecord[]>;

  /** Queries durable replication status records for all snapshots of a mailbox. */
  get_replication_status_by_owner(
    tenant_id: string,
    owner_id: string,
  ): Promise<ReplicationStatusRecord[]>;
}
