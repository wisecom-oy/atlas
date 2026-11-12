import { describe, expect, it, vi } from 'vitest';
import { OwnerBusyError } from '@wisecom/atlas-types';
import { StorageOwnerLeases } from '@wisecom/atlas-core/services/lease/storage-owner-leases';
import { owner_lease_key } from '@wisecom/atlas-core/services/lease/lease-record';
import { teams_checkpoint_prefix } from '@/services/shared/storage-keys';
import {
  build_env,
  CHANNEL,
  CHANNEL_ID,
  root,
  TEAM,
  TENANT,
} from './backup.service-storage-harness';
import { message } from './thread-store-harness';

const LEASE_KEY = owner_lease_key('teams', TEAM);

describe('TeamsBackupService under the team lease', () => {
  it('holds the lease while it runs and leaves none behind', async () => {
    let seen_during_run: string[] = [];
    const env = build_env(
      CHANNEL,
      {
        list_channel_messages_page: vi.fn(async () => {
          seen_during_run = env.harness.keys();
          return { roots: [root(message('m1'))] };
        }),
      },
      new StorageOwnerLeases(),
    );

    const result = await env.service.backup_team(TENANT, TEAM);

    expect(result.summary.healthy).toBe(true);
    expect(seen_during_run).toContain(LEASE_KEY);
    expect(env.harness.keys()).not.toContain(LEASE_KEY);
  });

  it('refuses a second run on the same team before writing anything', async () => {
    const env = build_env(
      CHANNEL,
      { list_channel_messages_page: vi.fn(async () => ({ roots: [root(message('m1'))] })) },
      new StorageOwnerLeases(),
    );
    const expires_at = new Date(Date.now() + 5 * 60_000).toISOString();
    env.harness.set_raw(
      LEASE_KEY,
      Buffer.from(
        JSON.stringify({
          format: 1,
          token: 'other-run',
          operation: 'backup',
          host: 'other-host',
          pid: 7,
          started_at: new Date().toISOString(),
          renewed_at: new Date().toISOString(),
          expires_at,
        }),
      ),
    );

    const error = await env.service.backup_team(TENANT, TEAM).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OwnerBusyError);
    expect((error as OwnerBusyError).message).toContain(expires_at);
    expect(env.harness.keys()).toEqual([LEASE_KEY]);
    expect(env.connector.get_team).not.toHaveBeenCalled();
    expect(
      env.harness.keys().some((key) => key.startsWith(teams_checkpoint_prefix(TEAM, CHANNEL_ID))),
    ).toBe(false);
  });
});
