import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { ConfigError } from '@wisecom/atlas-types';
import {
  delete_scopes,
  delete_snapshot_manifest,
} from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import { TeamsDeletionService } from '@/services/deletion/deletion.service';
import {
  teams_meta_prefix_for,
  teams_shard_prefix_for,
  TEAMS_KEYS,
} from '@/services/shared/storage-keys';

vi.mock('@wisecom/atlas-core/services/deletion/shared/prefix-deleter', () => ({
  delete_scopes: vi.fn(async () => ({
    deleted_objects: 0,
    deleted_manifests: 0,
    retained_objects: 0,
    retained_manifests: 0,
    failed_objects: 0,
    failed_manifests: 0,
  })),
  delete_snapshot_manifest: vi.fn(async () => ({
    deleted_objects: 0,
    deleted_manifests: 1,
    retained_objects: 0,
    retained_manifests: 0,
    failed_objects: 0,
    failed_manifests: 0,
  })),
}));

const TENANT = 'tenant-1';
const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
const SNAPSHOT = 'teams-snap-2000-bbbbbb';
const STORAGE = { name: 'storage-only' };

function setup() {
  const create_storage_only = vi.fn(async () => ({ storage: STORAGE }));
  const service = new TeamsDeletionService(
    {
      create_storage_only,
    } as unknown as TenantContextFactory,
    stub_owner_leases().leases,
  );
  return { service, create_storage_only };
}

describe('TeamsDeletionService.delete_team_data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the cursor, then manifests, then shards, then data, then quarantined indexes (A5, #694)', async () => {
    const { service } = setup();

    await service.delete_team_data(TENANT, TEAM);

    expect(delete_scopes).toHaveBeenCalledTimes(1);
    expect(delete_scopes).toHaveBeenCalledWith(STORAGE, [
      teams_meta_prefix_for(TEAM),
      TEAMS_KEYS.manifest_prefix_for(TEAM),
      teams_shard_prefix_for(TEAM),
      TEAMS_KEYS.data_prefix_for(TEAM),
      `_quarantine/${TEAMS_KEYS.manifest_prefix_for(TEAM)}`,
    ]);
  });

  it('builds the same scopes for an uppercase team id (issue #38)', async () => {
    const { service } = setup();

    await service.delete_team_data(TENANT, TEAM.toUpperCase());

    expect(delete_scopes).toHaveBeenCalledWith(STORAGE, [
      teams_meta_prefix_for(TEAM),
      TEAMS_KEYS.manifest_prefix_for(TEAM),
      teams_shard_prefix_for(TEAM),
      TEAMS_KEYS.data_prefix_for(TEAM),
      `_quarantine/${TEAMS_KEYS.manifest_prefix_for(TEAM)}`,
    ]);
  });

  it('rejects a team id that is not a GUID before opening storage (A9)', async () => {
    const { service, create_storage_only } = setup();

    await expect(service.delete_team_data(TENANT, 'not-a-guid')).rejects.toThrow(ConfigError);
    expect(create_storage_only).not.toHaveBeenCalled();
    expect(delete_scopes).not.toHaveBeenCalled();
  });
});

describe('TeamsDeletionService.delete_snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes only the manifest under the lowercased team id (A9)', async () => {
    const { service } = setup();

    await service.delete_snapshot(TENANT, TEAM.toUpperCase(), SNAPSHOT);

    expect(delete_snapshot_manifest).toHaveBeenCalledWith(
      STORAGE,
      TEAMS_KEYS.manifest_key(TEAM, SNAPSHOT),
      'teams',
      SNAPSHOT,
    );
  });

  it('rejects a team id that is not a GUID before opening storage (A9)', async () => {
    const { service, create_storage_only } = setup();

    await expect(service.delete_snapshot(TENANT, 'not-a-guid', SNAPSHOT)).rejects.toThrow(
      ConfigError,
    );
    expect(create_storage_only).not.toHaveBeenCalled();
  });
});
