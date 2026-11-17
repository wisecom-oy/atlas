/**
 * Team erasure under Object Lock or a refused delete. The objects that outlive the sweep must
 * reach the caller as retained or failed counts, never as a clean result (issue #634).
 */
import { describe, expect, it, vi } from 'vitest';
import { ObjectLockRetainedError, type TenantContextFactory } from '@wisecom/atlas-types';
import type { DeletionStorage } from '@wisecom/atlas-core/services/deletion/shared/prefix-deleter';
import { TeamsDeletionService } from '@/services/deletion/deletion.service';
import {
  teams_cursor_key,
  teams_shard_prefix_for,
  TEAMS_KEYS,
} from '@/services/shared/storage-keys';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
const CURSOR_KEY = teams_cursor_key(TEAM, 'channel-1');
const MANIFEST_KEY = TEAMS_KEYS.manifest_key(TEAM, 'teams-snap-2000-bbbbbb');
const SHARD_KEY = `${teams_shard_prefix_for(TEAM)}channel-1/shard-a.json`;
const DATA_KEYS = [
  `${TEAMS_KEYS.data_prefix_for(TEAM)}blob-a`,
  `${TEAMS_KEYS.data_prefix_for(TEAM)}blob-b`,
];
const ALL_KEYS = [CURSOR_KEY, MANIFEST_KEY, SHARD_KEY, ...DATA_KEYS];

/** A versioned bucket holding one version of every key, whose deletes `refuse` may reject. */
function versioned_storage(refuse: (key: string) => Error | undefined): DeletionStorage {
  return {
    delete: vi.fn(),
    list: vi.fn(async () => []),
    list_versions: vi.fn(async (prefix: string) =>
      ALL_KEYS.filter((key) => key.startsWith(prefix)).map((key) => ({
        key,
        version_id: `v-${key}`,
        is_delete_marker: false,
      })),
    ),
    delete_version: vi.fn(async (key: string) => {
      const error = refuse(key);
      if (error) throw error;
    }),
  };
}

function service_over(storage: DeletionStorage): TeamsDeletionService {
  return new TeamsDeletionService(
    {
      create_storage_only: vi.fn(async () => ({ tenant_id: 'tenant-1', storage })),
    } as unknown as TenantContextFactory,
    stub_owner_leases().leases,
  );
}

describe('TeamsDeletionService.delete_team_data survivors', () => {
  it('counts objects Object Lock retains as retained, not deleted', async () => {
    const storage = versioned_storage((key) =>
      key === CURSOR_KEY ? undefined : new ObjectLockRetainedError(key),
    );

    const result = await service_over(storage).delete_team_data('tenant-1', TEAM);

    expect(result).toEqual({
      deleted_objects: 1,
      deleted_manifests: 0,
      retained_objects: 3,
      retained_manifests: 1,
      failed_objects: 0,
      failed_manifests: 0,
    });
  });

  it('counts a delete refused for another reason as failed, not retained', async () => {
    const access_denied = Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
    const storage = versioned_storage((key) =>
      DATA_KEYS.includes(key) ? access_denied : undefined,
    );

    const result = await service_over(storage).delete_team_data('tenant-1', TEAM);

    expect(result).toEqual({
      deleted_objects: 2,
      deleted_manifests: 1,
      retained_objects: 0,
      retained_manifests: 0,
      failed_objects: 2,
      failed_manifests: 0,
    });
  });
});
