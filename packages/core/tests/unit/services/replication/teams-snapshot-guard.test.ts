import { describe, it, expect, vi, type Mock } from 'vitest';
import { ConfigError } from '@wisecom/atlas-types';
import type {
  ManifestRepository,
  OneDriveReplicationUseCase,
  SharePointReplicationUseCase,
  StorageTarget,
  StorageTargetFactory,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { ReplicationService } from '@/services/replication/replication.service';
import type { FullSnapshotReplicationService } from '@/services/replication/full-snapshot-replication.service';
import type { AtlasConfig } from '@/utils/config';

const TENANT = '00000000-0000-0000-0000-000000000000';
const TEAMS_SNAPSHOT = 'teams-snap-1700000000000-abcdef';

function make_service(): { service: ReplicationService; create: Mock } {
  const create = vi.fn();
  const service = new ReplicationService(
    { create } as unknown as TenantContextFactory,
    {} as unknown as ManifestRepository,
    {} as unknown as AtlasConfig,
    vi.fn(),
    {} as unknown as StorageTargetFactory,
    {} as unknown as OneDriveReplicationUseCase,
    {} as unknown as SharePointReplicationUseCase,
    {} as FullSnapshotReplicationService,
  );
  return { service, create };
}

describe('Teams snapshots in replication', () => {
  it('rejects replicating a Teams snapshot before any tenant lookup', async () => {
    const { service, create } = make_service();
    const target = {} as unknown as StorageTarget;

    const replicating = service.replicate_snapshot(TENANT, TEAMS_SNAPSHOT, [target]);
    await expect(replicating).rejects.toBeInstanceOf(ConfigError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects rehydrating a Teams snapshot with a clear unsupported error', async () => {
    const { service, create } = make_service();
    const source = {} as unknown as StorageTarget;

    await expect(service.rehydrate_snapshot(TENANT, TEAMS_SNAPSHOT, source)).rejects.toThrow(
      'Teams snapshots are not replicated yet',
    );
    expect(create).not.toHaveBeenCalled();
  });
});
