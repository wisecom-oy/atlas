import { inject, injectable } from 'inversify';
import type {
  OwnerLeasePort,
  ReplicationResult,
  SharePointReplicationUseCase,
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
import { SharePointReplicationService } from '@/services/replication/sharepoint-replication.service';
import {
  run_rehydration_under_lease,
  run_replication_under_lease,
  type RehydrationLeasePorts,
} from '@/services/replication/replication-owner-lease';
import { create_primary_target } from '@/services/replication/primary-target-factory';
import { ATLAS_CONFIG_TOKEN, type AtlasConfig } from '@/utils/config';

/**
 * Takes the site's lease around the SharePoint replication and rehydration entry points that act
 * on one site, then hands the work to {@link SharePointReplicationService}. The tenant-wide
 * recovery takes no site lease.
 */
@injectable()
export class LeasedSharePointReplicationService implements SharePointReplicationUseCase {
  constructor(
    @inject(SharePointReplicationService) private readonly _inner: SharePointReplicationService,
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
    @inject(STORAGE_TARGET_FACTORY_TOKEN) private readonly _target_factory: StorageTargetFactory,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
  ) {}

  /** Replicates one snapshot of a site while holding the site's lease. */
  async replicate_site(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    const owner = sharepoint_owner(site_id);
    return run_replication_under_lease(this._leases, this._tenant_factory, tenant_id, owner, () =>
      this._inner.replicate_site(tenant_id, owner.owner_id, snapshot_id, targets),
    );
  }

  /** Replicates a site's unreplicated snapshots while holding the site's lease. */
  async replicate_all_site_snapshots(
    tenant_id: string,
    site_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    const owner = sharepoint_owner(site_id);
    return run_replication_under_lease(this._leases, this._tenant_factory, tenant_id, owner, () =>
      this._inner.replicate_all_site_snapshots(tenant_id, owner.owner_id, targets),
    );
  }

  /** Recovers one snapshot of a site from a replica while holding the site's lease. */
  async rehydrate_site_snapshot(
    tenant_id: string,
    site_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    const owner = sharepoint_owner(site_id);
    return run_rehydration_under_lease(this.rehydration_ports(), tenant_id, source, owner, () =>
      this._inner.rehydrate_site_snapshot(tenant_id, owner.owner_id, snapshot_id, source),
    );
  }

  /** Recovers all snapshots of a site from a replica while holding the site's lease. */
  async rehydrate_site(
    tenant_id: string,
    site_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    const owner = sharepoint_owner(site_id);
    return run_rehydration_under_lease(this.rehydration_ports(), tenant_id, source, owner, () =>
      this._inner.rehydrate_site(tenant_id, owner.owner_id, source),
    );
  }

  /** Tenant-wide recovery takes no site lease; see the SDK concurrent operations section. */
  async rehydrate_all_sites(tenant_id: string, source: StorageTarget): Promise<ReplicationResult> {
    return this._inner.rehydrate_all_sites(tenant_id, source);
  }

  private rehydration_ports(): RehydrationLeasePorts {
    return {
      leases: this._leases,
      tenant_factory: this._tenant_factory,
      primary: create_primary_target(this._target_factory, this._config),
    };
  }
}

/** The SharePoint lease owner for a site id, normalized as the SharePoint keys use it. */
function sharepoint_owner(site_id: string): { workload: 'sharepoint'; owner_id: string } {
  return { workload: 'sharepoint', owner_id: normalize_owner_id(site_id) };
}
