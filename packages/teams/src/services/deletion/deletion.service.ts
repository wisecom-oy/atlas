import {
  delete_scopes,
  delete_snapshot_manifest,
} from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import type { DeletionResult } from '@wisecom/atlas-types';
import type { TeamsDeletionUseCase, TenantContextFactory } from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import { inject, injectable } from 'inversify';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

/**
 * Deletes Teams backup data. Content blobs are kept when a snapshot is deleted, as SharePoint
 * does: a storage-only context cannot decrypt manifests to find blobs unique to one snapshot.
 */
@injectable()
export class TeamsDeletionService implements TeamsDeletionUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
  ) {}

  /** Deletes every blob, manifest, and delta cursor of a team. */
  async delete_team_data(tenant_id: string, team_id: string): Promise<DeletionResult> {
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_scopes(storage, [
      TEAMS_KEYS.data_prefix_for(team_id),
      TEAMS_KEYS.manifest_prefix_for(team_id),
      TEAMS_KEYS.delta_cursor_key(team_id),
    ]);
  }

  /** Deletes one snapshot manifest. The blobs it references are kept. */
  async delete_snapshot(
    tenant_id: string,
    team_id: string,
    snapshot_id: string,
  ): Promise<DeletionResult> {
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    return delete_snapshot_manifest(
      storage,
      TEAMS_KEYS.manifest_key(team_id, snapshot_id),
      'teams',
      snapshot_id,
    );
  }
}
