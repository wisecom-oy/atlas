import { describe, expect, it, vi } from 'vitest';
import type { TeamsFilesFolderRef, TeamsGraphResource } from '@wisecom/atlas-types';
import { backup_channel, type ChannelStartState } from '@/services/backup/channel-backup-processor';
import {
  CHANNEL,
  CHANNEL_WITH_EMAIL,
  SHARED_CHANNEL,
  TEAM_ID,
  make_connector,
  make_scope,
  previous_shard,
} from './channel-backup-processor-harness';

const FOLDER: TeamsFilesFolderRef = { drive_id: 'drive-1', item_id: 'item-1' };
const STANDARD_CHANNEL = {
  id: 'channel-1',
  displayName: 'General',
  membershipType: 'standard',
} as TeamsGraphResource;

function start(overrides: Partial<ChannelStartState> = {}): ChannelStartState {
  return {
    previous_entry: undefined,
    previous_shard: undefined,
    stored_link: undefined,
    failed_roots: {},
    hosted_recheck: {},
    ...overrides,
  };
}

describe('backup_channel members and tabs', () => {
  it('reads members from the team for a standard channel and skips the member lookup', async () => {
    const connector = make_connector();

    const output = await backup_channel(make_scope(connector), STANDARD_CHANNEL, start());

    expect(connector.list_channel_members).not.toHaveBeenCalled();
    expect(output.shard.members).toEqual([]);
    expect(output.shard.members_from_team).toBe(true);
    expect(output.shard.team_id).toBe(TEAM_ID);
  });

  it('lists members for a private or non-standard channel', async () => {
    const connector = make_connector({
      list_channel_members: vi.fn(async () => [{ id: 'user-1' }]),
    });

    const output = await backup_channel(make_scope(connector), CHANNEL, start());

    expect(connector.list_channel_members).toHaveBeenCalledWith('tenant-1', TEAM_ID, 'channel-1');
    expect(output.shard.members).toEqual([{ id: 'user-1' }]);
    expect(output.shard.members_from_team).toBeUndefined();
  });

  it('stores the channel tabs as returned', async () => {
    const connector = make_connector({
      list_channel_tabs: vi.fn(async () => [{ id: 'tab-1', displayName: 'Wiki' }]),
    });

    const output = await backup_channel(make_scope(connector), CHANNEL, start());

    expect(output.shard.tabs).toEqual([{ id: 'tab-1', displayName: 'Wiki' }]);
  });
});

describe('backup_channel files folder', () => {
  it('stores the files folder Graph returns', async () => {
    const connector = make_connector({
      get_channel_files_folder: vi.fn(async () => FOLDER),
    });

    const output = await backup_channel(make_scope(connector), CHANNEL, start());

    expect(output.shard.files_folder).toEqual(FOLDER);
    expect(output.shard.files_folder_unavailable).toBeUndefined();
  });

  it('marks the folder unavailable and warns when Graph answers 403', async () => {
    const connector = make_connector({
      get_channel_files_folder: vi.fn(async () => 'unavailable' as const),
    });

    const output = await backup_channel(make_scope(connector), CHANNEL, start());

    expect(output.shard.files_folder_unavailable).toBe(true);
    expect(output.shard.files_folder).toBeUndefined();
    expect(output.warnings).toContain(
      'Channel channel-1: files folder not accessible (403); not retried until a --full run',
    );
  });

  it('reuses the stored folder without a lookup', async () => {
    const connector = make_connector({ get_channel_files_folder: vi.fn() });

    const output = await backup_channel(
      make_scope(connector),
      CHANNEL,
      start({
        previous_shard: { ...previous_shard({}), files_folder: FOLDER },
      }),
    );

    expect(connector.get_channel_files_folder).not.toHaveBeenCalled();
    expect(output.shard.files_folder).toEqual(FOLDER);
  });

  it('skips the lookup for a stored unavailable marker and keeps the marker', async () => {
    const connector = make_connector({ get_channel_files_folder: vi.fn() });

    const output = await backup_channel(
      make_scope(connector),
      CHANNEL,
      start({
        previous_shard: { ...previous_shard({}), files_folder_unavailable: true },
      }),
    );

    expect(connector.get_channel_files_folder).not.toHaveBeenCalled();
    expect(output.shard.files_folder_unavailable).toBe(true);
  });

  it('ignores the stored folder and marker on a --full run', async () => {
    const connector = make_connector({
      get_channel_files_folder: vi.fn(async () => FOLDER),
    });

    const output = await backup_channel(
      make_scope(connector, undefined, true),
      CHANNEL,
      start({
        previous_shard: { ...previous_shard({}), files_folder_unavailable: true },
      }),
    );

    expect(connector.get_channel_files_folder).toHaveBeenCalledTimes(1);
    expect(output.shard.files_folder).toEqual(FOLDER);
    expect(output.shard.files_folder_unavailable).toBeUndefined();
  });

  it('keeps the previous folder and warns when the lookup throws', async () => {
    const connector = make_connector({
      get_channel_files_folder: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });

    const output = await backup_channel(
      make_scope(connector, undefined, true),
      CHANNEL,
      start({
        previous_shard: { ...previous_shard({}), files_folder: FOLDER },
      }),
    );

    expect(output.shard.files_folder).toEqual(FOLDER);
    expect(output.warnings).toContain(
      'Channel channel-1: files folder not resolved (timeout); kept the previous value',
    );
  });
});

describe('backup_channel shared teams', () => {
  it('lists the teams a shared channel is shared with', async () => {
    const connector = make_connector({
      list_channel_shared_teams: vi.fn(async () => [{ id: 'other-team' }]),
    });

    const output = await backup_channel(make_scope(connector), SHARED_CHANNEL, start());

    expect(connector.list_channel_shared_teams).toHaveBeenCalledWith(
      'tenant-1',
      TEAM_ID,
      'channel-1',
    );
    expect(output.shard.shared_with_teams).toEqual([{ id: 'other-team' }]);
  });

  it('does not look up shared teams for a channel that is not shared', async () => {
    const connector = make_connector();

    const output = await backup_channel(make_scope(connector), CHANNEL_WITH_EMAIL, start());

    expect(connector.list_channel_shared_teams).not.toHaveBeenCalled();
    expect(output.shard.shared_with_teams).toBeUndefined();
  });

  it('keeps the previous shared teams and warns when the lookup throws', async () => {
    const previous = [{ id: 'old-team' }];
    const connector = make_connector({
      list_channel_shared_teams: vi.fn(async () => {
        throw new Error('503');
      }),
    });

    const output = await backup_channel(
      make_scope(connector),
      SHARED_CHANNEL,
      start({
        previous_shard: { ...previous_shard({}), shared_with_teams: previous },
      }),
    );

    expect(output.shard.shared_with_teams).toEqual(previous);
    expect(output.warnings).toContain(
      'Channel channel-1: shared teams not resolved (503); kept the previous value',
    );
  });
});

describe('backup_channel shard identity', () => {
  it('stamps the shard with the team, channel, and format version', async () => {
    const output = await backup_channel(make_scope(make_connector()), CHANNEL, start());

    expect(output.shard).toMatchObject({
      format_version: 1,
      team_id: TEAM_ID,
      channel_id: 'channel-1',
      channel: CHANNEL,
    });
  });
});
