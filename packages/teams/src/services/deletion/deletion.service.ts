import {
  delete_scopes,
  delete_snapshot_manifest,
} from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import type { DeletionResult } from '@wisecom/atlas-types';
import type { TeamsDeletionUseCase, TenantContextFactory } from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import { inject, injectable } from 'inversify';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';
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

  /** Deletes every blob, manifest, and delta cursor of a team. */
  async delete_team_data(tenant_id: string, team_id: string): Promise<DeletionResult> {
    const normalized_team_id = normalize_team_id(team_id);
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    // Cursor goes first so no incremental run follows a partial delete; manifests go before data
    // so no surviving manifest points at deleted blobs.
    return delete_scopes(storage, [
      TEAMS_KEYS.delta_cursor_key(normalized_team_id),
      TEAMS_KEYS.manifest_prefix_for(normalized_team_id),
      TEAMS_KEYS.data_prefix_for(normalized_team_id),
    ]);
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
