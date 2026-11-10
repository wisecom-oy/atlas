import {
  delete_scopes,
  delete_snapshot_manifest,
  has_survivors,
} from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type { DeletionResult } from '@wisecom/atlas-types';
import type { TeamsDeletionUseCase, TenantContextFactory } from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
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
 */
@injectable()
export class TeamsDeletionService implements TeamsDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
  ) {}

  /**
   * Deletes every blob, index, shard, and channel cursor of a team. Survivors stay in the result
   * and are logged: Object Lock retains locked objects, and a failed delete leaves its object.
   */
  async delete_team_data(tenant_id: string, team_id: string): Promise<DeletionResult> {
    const normalized_team_id = normalize_team_id(team_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    // Cursors go first so no incremental run follows a partial delete. Manifests and shards go
    // before data blobs, so an interrupted run leaves orphaned blobs rather than manifests that
    // point at nothing.
    const result = await delete_scopes(storage, [
      teams_meta_prefix_for(normalized_team_id),
      TEAMS_KEYS.manifest_prefix_for(normalized_team_id),
      teams_shard_prefix_for(normalized_team_id),
      TEAMS_KEYS.data_prefix_for(normalized_team_id),
    ]);
    if (has_survivors(result)) {
      logger.error(
        `Teams backup deletion left ${result.retained_objects + result.retained_manifests} ` +
          `object(s) retained by Object Lock and ${result.failed_objects + result.failed_manifests} failed.`,
      );
    }
    return result;
  }

  /** Deletes one snapshot manifest. The blobs it references are kept. */
  async delete_snapshot(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    const manifest_key = TEAMS_KEYS.manifest_key(normalize_team_id(team_id), snapshot_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_snapshot_manifest(storage, manifest_key, 'teams', snapshot_id);
  }
}
