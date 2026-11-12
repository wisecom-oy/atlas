import {
  delete_scopes,
  delete_snapshot_manifest,
} from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import {
  delete_under_owner_lease,
  type LeasedDeletionDeps,
} from '@wisecom/atlas-core/services/deletion/shared/leased-deletion';
import { quarantined_copies_of } from '@wisecom/atlas-core/services/quarantine/stored-object-quarantine';
import type { DeletionResult } from '@wisecom/atlas-types';
import type { OwnerLeases, TeamsDeletionUseCase, TenantContextFactory } from '@wisecom/atlas-types';
import { OWNER_LEASES_TOKEN, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
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
 * Every deletion holds the team's lease, so it never runs under a backup of the same team.
 */
@injectable()
export class TeamsDeletionService implements TeamsDeletionUseCase {
  private readonly _deps: LeasedDeletionDeps;

  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) tenant_factory: TenantContextFactory,
    @inject(OWNER_LEASES_TOKEN) leases: OwnerLeases,
  ) {
    this._deps = { tenant_factory, leases };
  }

  /**
   * Deletes every blob, index, shard, and channel cursor of a team, and the quarantined copies of
   * its indexes, which still list its channels (issue #694). Objects that Object Lock
   * retains or that fail to delete are counted in the result; callers report them, as for every
   * other workload.
   */
  async delete_team_data(tenant_id: string, team_id: string): Promise<DeletionResult> {
    const normalized_team_id = normalize_team_id(team_id);
    // Cursors go first so no incremental run follows a partial delete. Manifests and shards go
    // before data blobs, so an interrupted run leaves orphaned blobs rather than manifests that
    // point at nothing.
    return delete_under_owner_lease(this._deps, tenant_id, 'teams', normalized_team_id, (storage) =>
      delete_scopes(storage, [
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
    return delete_under_owner_lease(this._deps, tenant_id, 'teams', normalized_team_id, (storage) =>
      delete_snapshot_manifest(storage, manifest_key, 'teams', snapshot_id),
    );
  }
}
