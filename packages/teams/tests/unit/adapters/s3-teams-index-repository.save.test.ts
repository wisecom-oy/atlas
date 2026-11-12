import { describe, expect, it, vi } from 'vitest';
import type { TeamsSnapshotIndex } from '@wisecom/atlas-types';
import {
  RefusedWriteError,
  StoredObjectConflictError,
  UnreadableContentError,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3TeamsIndexRepository } from '@/adapters/s3-teams-index-repository.adapter';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

const TEAM = '00000000-0000-0000-0000-000000000001';
const SNAPSHOT = 'teams-snap-1000-aaaaaa';
const KEY = TEAMS_KEYS.manifest_key(TEAM, SNAPSHOT);

function index(overrides: Record<string, unknown> = {}): TeamsSnapshotIndex {
  return {
    id: SNAPSHOT,
    format_version: 1,
    tenant_id: 'tenant-test',
    team_id: TEAM,
    snapshot_id: SNAPSHOT,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    team: { id: TEAM },
    members: [],
    channels: [
      {
        channel_id: 'channel-1',
        shard_key: 'teams/shards/shard-name',
        shard_checksum: 'sum',
        thread_count: 1,
        message_count: 2,
        size_bytes: 3,
      },
    ],
    totals: { thread_count: 1, message_count: 2, size_bytes: 3 },
    ...overrides,
  } as unknown as TeamsSnapshotIndex;
}

describe('S3TeamsIndexRepository.save', () => {
  it('stores an index its reader accepts, create-only, and reads it back once', async () => {
    const harness = in_memory_tenant_context();
    const repo = new S3TeamsIndexRepository();
    const put = vi.spyOn(harness.ctx.storage, 'put');
    const get = vi.spyOn(harness.ctx.storage, 'get');

    await repo.save(harness.ctx, index());

    expect(put).toHaveBeenCalledWith(KEY, harness.raw(KEY), undefined, undefined, undefined, true);
    expect(get.mock.calls).toEqual([[KEY]]);
    const read = await repo.read_index_at(harness.ctx, KEY);
    expect(read?.snapshot_id).toBe(SNAPSHOT);
    expect(read?.created_at).toEqual(new Date('2025-01-01T00:00:00.000Z'));
  });

  it.each([
    ['a channel row without its channel id', { channels: [{ shard_key: 'k' }] }],
    ['a count that is not a finite number', { totals: { thread_count: Number.NaN } }],
    ['an unparseable created_at', { created_at: new Date(Number.NaN) }],
    ['a format version this build does not read', { format_version: 2 }],
  ])('refuses an index with %s and writes nothing', async (_label, overrides) => {
    const harness = in_memory_tenant_context();

    const save = new S3TeamsIndexRepository().save(harness.ctx, index(overrides));

    await expect(save).rejects.toBeInstanceOf(RefusedWriteError);
    await expect(save).rejects.toThrow(KEY);
    await expect(save).rejects.not.toBeInstanceOf(UnreadableContentError);
    expect(harness.keys()).toEqual([]);
  });

  it('never replaces an index already stored under the snapshot id', async () => {
    const harness = in_memory_tenant_context();
    const repo = new S3TeamsIndexRepository();
    await repo.save(harness.ctx, index());
    const first = Buffer.from(harness.raw(KEY)!);

    const colliding = repo.save(harness.ctx, index({ members: [{ id: 'member-1' }] }));

    await expect(colliding).rejects.toBeInstanceOf(StoredObjectConflictError);
    expect(harness.raw(KEY)!.equals(first)).toBe(true);
  });
});
