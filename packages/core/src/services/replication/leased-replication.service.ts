import { inject, injectable } from 'inversify';
import type {
  ManifestRepository,
  OwnerLeasePort,
  ReplicationResult,
  ReplicationStatusRecord,
  ReplicationUseCase,
  StorageTarget,
  StorageTargetFactory,
  TenantContext,
  TenantContextFactory,
  TenantRehydrationResult,
} from '@wisecom/atlas-types';
import {
  MANIFEST_REPOSITORY_TOKEN,
  OWNER_LEASE_TOKEN,
  STORAGE_TARGET_FACTORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { ReplicationService } from '@/services/replication/replication.service';
import {
  is_drive_snapshot_id,
  refuse_contacts_snapshot,
  refuse_calendar_snapshot,
} from '@/services/replication/drive-snapshot-router';
import { require_outlook_manifest } from '@/services/replication/outlook-manifest-handler';
import { reject_teams_snapshot } from '@/services/replication/teams-snapshot-guard';
import {
  run_rehydration_under_lease,
  run_replication_under_lease,
  type RehydrationLeasePorts,
  type ReplicationLeaseOwner,
} from '@/services/replication/replication-owner-lease';
import { create_primary_target } from '@/services/replication/primary-target-factory';
import { ATLAS_CONFIG_TOKEN, type AtlasConfig } from '@/utils/config';

/**
 * Takes the owner's lease around the Outlook replication and rehydration entry points, then hands
 * the work to {@link ReplicationService}, which stays unaware of leases. Drive snapshots pass
 * through: their workload services take the lease for the one owner they act on.
 *
 * The owner of a snapshot is read from its manifest before the lease is taken. That read touches
 * no state; the lease is taken before any write.
 */
@injectable()
export class LeasedReplicationService implements ReplicationUseCase {
  constructor(
    @inject(ReplicationService) private readonly _inner: ReplicationService,
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
    @inject(STORAGE_TARGET_FACTORY_TOKEN) private readonly _target_factory: StorageTargetFactory,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
  ) {}

  /** Replicates one snapshot while holding the lease of the owner it belongs to. */
  async replicate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    refuse_unsupported_snapshot(snapshot_id);
    if (is_drive_snapshot_id(snapshot_id)) {
      return this._inner.replicate_snapshot(tenant_id, snapshot_id, targets);
    }
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    const owner = await this.outlook_owner_of(ctx, snapshot_id).finally(() => ctx.destroy());
    return run_replication_under_lease(this._leases, this._tenant_factory, tenant_id, owner, () =>
      this._inner.replicate_snapshot(tenant_id, snapshot_id, targets),
    );
  }

  /** Replicates a mailbox's unreplicated snapshots while holding the mailbox's lease. */
  async replicate_mailbox(
    tenant_id: string,
    owner_id: string,
    targets: StorageTarget[],
  ): Promise<ReplicationResult[]> {
    const owner = outlook_owner(owner_id);
    return run_replication_under_lease(this._leases, this._tenant_factory, tenant_id, owner, () =>
      this._inner.replicate_mailbox(tenant_id, owner.owner_id, targets),
    );
  }

  /** Recovers one snapshot from a replica while holding the lease of the owner it belongs to. */
  async rehydrate_snapshot(
    tenant_id: string,
    snapshot_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    refuse_unsupported_snapshot(snapshot_id);
    if (is_drive_snapshot_id(snapshot_id)) {
      return this._inner.rehydrate_snapshot(tenant_id, snapshot_id, source);
    }
    const source_ctx = await source.create_context(tenant_id);
    const owner = await this.outlook_owner_of(source_ctx, snapshot_id).finally(() =>
      source_ctx.destroy(),
    );
    return run_rehydration_under_lease(this.rehydration_ports(), tenant_id, source, owner, () =>
      this._inner.rehydrate_snapshot(tenant_id, snapshot_id, source),
    );
  }

  /** Recovers a mailbox from a replica while holding the mailbox's lease on primary. */
  async rehydrate_mailbox(
    tenant_id: string,
    owner_id: string,
    source: StorageTarget,
  ): Promise<ReplicationResult> {
    const owner = outlook_owner(owner_id);
    return run_rehydration_under_lease(this.rehydration_ports(), tenant_id, source, owner, () =>
      this._inner.rehydrate_mailbox(tenant_id, owner.owner_id, source),
    );
  }

  /** Tenant-wide recovery takes no owner lease; see the SDK concurrent operations section. */
  async rehydrate_tenant(
    tenant_id: string,
    source: StorageTarget,
  ): Promise<TenantRehydrationResult> {
    return this._inner.rehydrate_tenant(tenant_id, source);
  }

  /** Reads replication status records. Reads take no lease. */
  async get_replication_status(
    tenant_id: string,
    snapshot_id?: string,
  ): Promise<ReplicationStatusRecord[]> {
    return this._inner.get_replication_status(tenant_id, snapshot_id);
  }

  /** Reads one owner's replication status records. Reads take no lease. */
  async get_replication_status_by_owner(
    tenant_id: string,
    owner_id: string,
  ): Promise<ReplicationStatusRecord[]> {
    return this._inner.get_replication_status_by_owner(tenant_id, owner_id);
  }

  /** The owner an Outlook snapshot belongs to, from its manifest in the given context. */
  private async outlook_owner_of(
    ctx: TenantContext,
    snapshot_id: string,
  ): Promise<ReplicationLeaseOwner> {
    const manifest = await require_outlook_manifest(this._manifests, ctx, snapshot_id, 'source');
    return outlook_owner(manifest.owner_id);
  }

  private rehydration_ports(): RehydrationLeasePorts {
    return {
      leases: this._leases,
      tenant_factory: this._tenant_factory,
      primary: create_primary_target(this._target_factory, this._config),
    };
  }
}

/** The Outlook lease owner for a mailbox id, normalized as the Outlook keys use it. */
function outlook_owner(owner_id: string): ReplicationLeaseOwner {
  return { workload: 'outlook', owner_id: normalize_owner_id(owner_id) };
}

/**
 * Refuses the snapshot kinds that have no replication path, before any lookup. The same checks run
 * in the inner services; they run first here too so the owner lookup does not report NotFound.
 */
function refuse_unsupported_snapshot(snapshot_id: string): void {
  reject_teams_snapshot(snapshot_id);
  refuse_contacts_snapshot(snapshot_id);
  refuse_calendar_snapshot(snapshot_id);
}
