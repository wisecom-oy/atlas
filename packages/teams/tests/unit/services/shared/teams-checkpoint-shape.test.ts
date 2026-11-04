import { describe, expect, it } from 'vitest';
import { UnreadableContentError } from '@wisecom/atlas-types';
import {
  assert_checkpoint_head_shape,
  assert_checkpoint_segment_shape,
} from '@/services/shared/teams-checkpoint-shape';

const KEY = 'teams/checkpoints/channel-1/head.json';

function valid_head(): Record<string, unknown> {
  return {
    format_version: 1,
    team_id: 'team-1',
    channel_id: 'channel-1',
    baseline_shard_key: 'shard-1',
    mode: 'full',
    phase: 'list',
    next_page: 'page-2',
    segments: ['seg-abc-0'],
    failed_roots: {},
    hosted_recheck: {},
    updated_at: '2025-01-01T00:00:00.000Z',
  };
}

describe('assert_checkpoint_head_shape', () => {
  it('accepts a well-formed head', () => {
    expect(() => assert_checkpoint_head_shape(KEY, valid_head())).not.toThrow();
  });

  it('rejects a phase the reader does not know', () => {
    expect(() => assert_checkpoint_head_shape(KEY, { ...valid_head(), phase: 'sweep' })).toThrow(
      UnreadableContentError,
    );
  });

  it('rejects a segment name that is not a string', () => {
    expect(() => assert_checkpoint_head_shape(KEY, { ...valid_head(), segments: [7] })).toThrow(
      UnreadableContentError,
    );
  });
});

describe('assert_checkpoint_segment_shape', () => {
  it('accepts a segment whose removal markers are null', () => {
    const segment = { threads: { 'msg-1': null }, seen: ['msg-1'] };
    expect(() => assert_checkpoint_segment_shape(KEY, segment)).not.toThrow();
  });

  it('rejects a seen ID that is not a string', () => {
    expect(() => assert_checkpoint_segment_shape(KEY, { threads: {}, seen: ['msg-1', 2] })).toThrow(
      UnreadableContentError,
    );
  });
});
