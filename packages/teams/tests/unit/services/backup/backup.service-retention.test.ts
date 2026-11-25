import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { record_lock_policies } from '@wisecom/atlas-types/testing/lock-policy-recorder';
import { ObjectLockingStorage } from '@wisecom/atlas-core/services/shared/run-object-lock';
import { S3TeamsChannelCheckpointRepository } from '@/adapters/s3-teams-channel-checkpoint-repository.adapter';
import {
  TEAMS_KEYS,
  teams_checkpoint_head_key,
  teams_checkpoint_hosted_key,
  teams_checkpoint_segment_key,
  teams_cursor_key,
  teams_shard_prefix_for,
} from '@/services/shared/storage-keys';
import {
  build_env,
  CHANNEL,
  CHANNEL_ID,
  root,
  TEAM,
  TENANT,
} from './backup.service-storage-harness';
import { message } from './thread-store-harness';

const RUN_POLICY = { mode: 'GOVERNANCE' as const, retain_until: '2030-01-01T00:00:00.000Z' };

describe('Teams backup with --retention-days (#919)', () => {
  it('locks the index, shards and blobs, and leaves the channel cursor unlocked', async () => {
    let recorder: ReturnType<typeof record_lock_policies> | undefined;
    const env = build_env(
      CHANNEL,
      { list_channel_messages_page: vi.fn(async () => ({ roots: [root(message('m1'))] })) },
      (storage) => (recorder = record_lock_policies(storage)).storage,
    );

    const result = await env.service.backup_team(TENANT, TEAM, {
      object_lock_request: { retention_days: 30 },
    });

    expect(result.summary.healthy).toBe(true);
    const locked = recorder?.locked_keys() ?? [];
    expect(
      locked.filter((key) => key.startsWith(TEAMS_KEYS.manifest_prefix_for(TEAM))),
    ).toHaveLength(1);
    expect(locked.filter((key) => key.startsWith(teams_shard_prefix_for(TEAM)))).toHaveLength(1);
    expect(locked.filter((key) => key.startsWith(TEAMS_KEYS.data_prefix_for(TEAM)))).toHaveLength(
      1,
    );
    expect(recorder?.unlocked_keys()).toEqual([teams_cursor_key(TEAM, CHANNEL_ID)]);
  });

  it('writes every checkpoint object without a lock even through a retained context', async () => {
    const harness = in_memory_tenant_context(TENANT);
    const recorder = record_lock_policies(harness.ctx.storage);
    const ctx: TenantContext = {
      ...harness.ctx,
      storage: new ObjectLockingStorage(recorder.storage, RUN_POLICY),
    };
    const repository = new S3TeamsChannelCheckpointRepository();

    await repository.save_segment(ctx, TEAM, CHANNEL_ID, 'seg-0', { threads: {}, seen: [] });
    await repository.save_hosted_entry(ctx, TEAM, CHANNEL_ID, 'h-0', {
      key: 'root-1//h1',
      ref: { storage_key: 'teams/data/hosted/name', checksum: 'sum', size_bytes: 3 },
    });
    await repository.save_head(ctx, {
      format_version: 1,
      team_id: TEAM,
      channel_id: CHANNEL_ID,
      start_link: undefined,
      pending_delta_link: undefined,
      next_page: undefined,
      baseline_shard_key: undefined,
      mode: 'full',
      phase: 'list',
      segments: ['seg-0'],
      failed_roots: {},
      hosted_recheck: {},
      updated_at: '2025-01-01T00:00:00.000Z',
    });

    expect(recorder.locked_keys()).toEqual([]);
    expect(recorder.unlocked_keys()).toEqual(
      [
        teams_checkpoint_head_key(TEAM, CHANNEL_ID),
        teams_checkpoint_hosted_key(TEAM, CHANNEL_ID, 'h-0'),
        teams_checkpoint_segment_key(TEAM, CHANNEL_ID, 'seg-0'),
      ].sort(),
    );
  });
});
