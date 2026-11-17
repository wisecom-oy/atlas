import { describe, expect, it } from 'vitest';
import {
  all_index_keys,
  teams_channel_shard_key,
  teams_checkpoint_head_key,
  teams_checkpoint_prefix,
  teams_checkpoint_segment_key,
  teams_cursor_key,
  teams_meta_prefix_for,
  teams_shard_prefix_for,
  team_index_keys,
} from '@/services/shared/storage-keys';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';

const TEAM = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab';
const OTHER_TEAM = '00000000-0000-4000-8000-000000000002';
const INDEX = `teams/manifests/${TEAM}/teams-snap-2000-bbbbbb.json`;
const SHARD = teams_channel_shard_key(TEAM, 'channel-1', 'shard-name');

describe('Teams index listing keys', () => {
  it("keeps only one team's index objects and drops its channel shards (N2)", () => {
    const keys = [INDEX, SHARD, `teams/manifests/${OTHER_TEAM}/teams-snap-1-cccccc.json`];

    expect(team_index_keys(keys, TEAM)).toEqual([INDEX]);
  });

  it('keeps every team index object of the tenant and drops every shard (N2)', () => {
    const other_index = `teams/manifests/${OTHER_TEAM}/teams-snap-1-cccccc.json`;
    const keys = [INDEX, SHARD, other_index];

    expect(all_index_keys(keys)).toEqual([INDEX, other_index]);
  });
});

describe('Teams cursor and shard keys', () => {
  it('places each channel cursor under its team meta prefix so team deletion removes it', () => {
    const cursor = teams_cursor_key(TEAM, 'channel-1');

    expect(cursor.startsWith(teams_meta_prefix_for(TEAM))).toBe(true);
    expect(cursor.endsWith('/channel-1.json')).toBe(true);
  });

  it('places each channel shard as teams/shards/{team}/{channel}/{content}.json (P10)', () => {
    expect(SHARD).toBe(`teams/shards/${TEAM}/channel-1/shard-name.json`);
    expect(SHARD.startsWith(teams_shard_prefix_for(TEAM))).toBe(true);
  });

  it('keeps shards out of the manifest prefix so an index listing never returns them (P10)', () => {
    expect(SHARD.startsWith(TEAMS_KEYS.manifest_prefix_for(TEAM))).toBe(false);
  });
});

describe('Teams checkpoint keys', () => {
  it('places each channel checkpoint under the team meta prefix so team deletion removes it', () => {
    const head = teams_checkpoint_head_key(TEAM, 'channel-1');

    expect(head.startsWith(teams_meta_prefix_for(TEAM))).toBe(true);
    expect(head.startsWith(teams_checkpoint_prefix(TEAM, 'channel-1'))).toBe(true);
  });

  it('names segments under their channel prefix, apart from the head', () => {
    const segment = teams_checkpoint_segment_key(TEAM, 'channel-1', 'seg-abc-0');

    expect(segment.startsWith(teams_checkpoint_prefix(TEAM, 'channel-1'))).toBe(true);
    expect(segment).not.toBe(teams_checkpoint_head_key(TEAM, 'channel-1'));
  });
});
