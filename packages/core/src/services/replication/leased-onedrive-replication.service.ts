import { inject, injectable } from 'inversify';
import type {
  OneDriveReplicationUseCase,
  OwnerLeasePort,
  ReplicationResult,
  StorageTarget,
  StorageTargetFactory,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import {
  OWNER_LEASE_TOKEN,
  STORAGE_TARGET_FACTORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { OneDriveReplicationService } from '@/services/replication/onedrive-replication.service';
import {
  run_rehydration_under_lease,
  run_replication_under_lease,
  type RehydrationLeasePorts,
} from '@/services/replication/replication-owner-lease';
import { create_primary_target } from '@/services/replication/primary-target-factory';
import { ATLAS_CONFIG_TOKEN, type AtlasConfig } from '@/utils/config';

/**
 * Takes the drive owner's lease around the OneDrive replication and rehydration entry points that
 * act on one owner, then hands the work to {@link OneDriveReplicationService}. The tenant-wide
 * recovery takes no owner lease.
 */
@injectable()
export class LeasedOneDriveReplicationService implements OneDriveReplicationUseCase {
  constructor(
    @inject(OneDriveReplicationService) private readonly _inner: OneDriveReplicationService,
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
    @inject(STORAGE_TARGET_FACTORY_TOKEN) private readonly _target_factory: StorageTargetFactory,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
  ) {}

  /** Replicates one snapshot of an owner while holding the owner's lease. */
  async replicate_owner(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    const owner = onedrive_owner(owner_id);
    return run_replication_under_lease(this._leases, this._tenant_factory, tenant_id, owner, () =>
      this._inner.replicate_owner(tenant_id, owner.owner_id, snapshot_id, targets),
    );
  }

  /** Replicates an owner's unreplicated snapshots while holding the owner's lease. */
  async replicate_all_owner_snapshots(
    tenant_id: string,
    owner_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    const owner = onedrive_owner(owner_id);
    return run_replication_under_lease(this._leases, this._tenant_factory, tenant_id, owner, () =>
      this._inner.replicate_all_owner_snapshots(tenant_id, owner.owner_id, targets),
    );
  }

  /** Recovers one snapshot of an owner from a replica while holding the owner's lease. */
  async rehydrate_owner_snapshot(
    tenant_id: string,
    owner_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    const owner = onedrive_owner(owner_id);
    return run_rehydration_under_lease(this.rehydration_ports(), tenant_id, source, owner, () =>
      this._inner.rehydrate_owner_snapshot(tenant_id, owner.owner_id, snapshot_id, source),
    );
  }

  /** Recovers all snapshots of an owner from a replica while holding the owner's lease. */
  async rehydrate_owner(
    tenant_id: string,
    owner_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    const owner = onedrive_owner(owner_id);
    return run_rehydration_under_lease(this.rehydration_ports(), tenant_id, source, owner, () =>
      this._inner.rehydrate_owner(tenant_id, owner.owner_id, source),
    );
  }

  /** Tenant-wide recovery takes no owner lease; see the SDK concurrent operations section. */
  async rehydrate_all_owners(tenant_id: string, source: StorageTarget): Promise<ReplicationResult> {
    return this._inner.rehydrate_all_owners(tenant_id, source);
  }

  private rehydration_ports(): RehydrationLeasePorts {
    return {
      leases: this._leases,
      tenant_factory: this._tenant_factory,
      primary: create_primary_target(this._target_factory, this._config),
    };
  }
}

/** The OneDrive lease owner for an owner id, normalized as the OneDrive keys use it. */
function onedrive_owner(owner_id: string): { workload: 'onedrive'; owner_id: string } {
  return { workload: 'onedrive', owner_id: normalize_owner_id(owner_id) };
}
