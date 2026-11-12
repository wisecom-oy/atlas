import {
  erase_leased_owner_scopes,
  run_owner_erasure,
  type LeasedDeletionPorts,
} from '@wisecom/atlas-core/services/deletion/shared/leased-owner-deletion';
import { delete_snapshot_manifest } from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import { quarantined_copies_of } from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import type { DeletionResult } from '@wisecom/atlas-types';
import type {
  OwnerLeasePort,
  TeamsDeletionUseCase,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OWNER_LEASE_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import { inject, injectable } from 'inversify';
import {
  teams_meta_prefix_for,
  teams_shard_prefix_for,
  TEAMS_KEYS,
} from '@/services/shared/storage-keys';
import { normalize_team_id } from '@/services/shared/team-id';

/**
 * Deletes Teams backup data. Content blobs are kept when a snapshot is deleted, as SharePoint
 * does: a storage-only context cannot decrypt manifests to find blobs unique to one snapshot.
 *
 * Each deletion holds the team's lease, so it is refused with `OwnerBusyError` while a backup of
 * the team runs and cannot remove a checkpoint under it (issue #623).
 */
@injectable()
export class TeamsDeletionService implements TeamsDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(OWNER_LEASE_TOKEN) private readonly _leases: OwnerLeasePort,
  ) {}

  private get _ports(): LeasedDeletionPorts {
    return { tenant_factory: this._tenant_factory, leases: this._leases };
  }

  /**
   * Deletes every blob, index, shard, and channel cursor of a team, and the quarantined copies of
   * its indexes, which still list its channels (issue #694). Objects that Object Lock
   * retains or that fail to delete are counted in the result; callers report them, as for every
   * other workload.
   */
  async delete_team_data(tenant_id: string, team_id: string): Promise<DeletionResult> {
    const normalized_team_id = normalize_team_id(team_id);
    const owner = { workload: 'teams', owner_id: normalized_team_id } as const;
    // Cursors go first so no incremental run follows a partial delete. Manifests and shards go
    // before data blobs, so an interrupted run leaves orphaned blobs rather than manifests that
    // point at nothing.
    return run_owner_erasure(this._ports, tenant_id, owner, (storage, lease) =>
      erase_leased_owner_scopes(storage, lease, [
        teams_meta_prefix_for(normalized_team_id),
        TEAMS_KEYS.manifest_prefix_for(normalized_team_id),
        teams_shard_prefix_for(normalized_team_id),
        TEAMS_KEYS.data_prefix_for(normalized_team_id),
        ...quarantined_copies_of([TEAMS_KEYS.manifest_prefix_for(normalized_team_id)]),
      ]),
    );
  }

  /** Deletes one snapshot manifest. The blobs it references are kept. */
  async delete_snapshot(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    const normalized_team_id = normalize_team_id(team_id);
    const manifest_key = TEAMS_KEYS.manifest_key(normalized_team_id, snapshot_id);
    const owner = { workload: 'teams', owner_id: normalized_team_id } as const;
    return run_owner_erasure(this._ports, tenant_id, owner, (storage, lease) => {
      lease.assert_held();
      return delete_snapshot_manifest(storage, manifest_key, 'teams', snapshot_id);
    });
  }
}
