import { describe, expect, it } from 'vitest';
import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import {
  assert_cursor_shape,
  assert_index_shape,
  assert_shard_shape,
} from '@/services/shared/teams-object-shape';

const INDEX_KEY = 'teams/manifests/team-1/teams-snap-1-aaaaaa.json';
const SHARD_KEY = 'teams/shards/team-1/channel-1/aaaaaa.json';
const CURSOR_KEY = 'teams/_meta/team-1/channels/channel-1.json';

const totals = { thread_count: 0, message_count: 0, size_bytes: 0 };

function index_body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'teams-snap-1',
    format_version: 1,
    tenant_id: 'tenant-test',
    team_id: 'team-1',
    snapshot_id: 'snap-1',
    created_at: '2025-01-01T00:00:00.000Z',
    team: {},
    members: [],
    channels: [],
    totals,
    ...overrides,
  };
}

function message_ref(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    storage_key: 'teams/data/aa/bb',
    checksum: 'c',
    size_bytes: 1,
    last_modified_at: '2025-01-01T00:00:00.000Z',
    hosted: {},
    ...overrides,
  };
}

function shard_body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: 1,
    team_id: 'team-1',
    channel_id: 'channel-1',
    channel: {},
    members: [],
    tabs: [],
    read_mode: 'delta',
    threads: {},
    ...overrides,
  };
}

function cursor_body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format_version: 1,
    team_id: 'team-1',
    channel_id: 'channel-1',
    baseline_shard_key: SHARD_KEY,
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Returns the error the validator raised, or undefined when it accepted the body. */
function error_of(check: () => void): unknown {
  try {
    check();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('assert_index_shape', () => {
  it('accepts a well-formed format 1 index', () => {
    const channel = {
      channel_id: 'channel-1',
      shard_key: SHARD_KEY,
      shard_checksum: 'c',
      thread_count: 0,
      message_count: 0,
      size_bytes: 0,
    };

    expect(() => assert_index_shape(INDEX_KEY, index_body({ channels: [channel] }))).not.toThrow();
  });

  it('rejects a branch-era format 1 index whose channels lack shard_key, naming the key (P1)', () => {
    const branch_era = index_body({
      channels: [{ channel_id: 'channel-1', thread_count: 0, message_count: 0, size_bytes: 0 }],
    });

    const error = error_of(() => assert_index_shape(INDEX_KEY, branch_era));

    expect(error).toBeInstanceOf(UnreadableContentError);
    expect((error as Error).message).toContain(INDEX_KEY);
  });

  it('rejects an index whose totals are missing', () => {
    const error = error_of(() => assert_index_shape(INDEX_KEY, index_body({ totals: undefined })));

    expect(error).toBeInstanceOf(UnreadableContentError);
  });

  it('reports a newer format before inspecting its shape, so it is unsupported not unreadable', () => {
    const newer = index_body({ format_version: 2, channels: 'not-an-array' });

    expect(error_of(() => assert_index_shape(INDEX_KEY, newer))).toBeInstanceOf(
      UnsupportedFormatVersionError,
    );
  });

  it('rejects a body that is not a JSON object', () => {
    expect(error_of(() => assert_index_shape(INDEX_KEY, null))).toBeInstanceOf(
      UnreadableContentError,
    );
  });
});

describe('assert_shard_shape', () => {
  it('accepts a shard with a delta read and a stored message thread', () => {
    const threads = { 'root-1': { root: message_ref(), replies: {} } };

    expect(() => assert_shard_shape(SHARD_KEY, shard_body({ threads }))).not.toThrow();
  });

  it('rejects an unknown read_mode', () => {
    const error = error_of(() =>
      assert_shard_shape(SHARD_KEY, shard_body({ read_mode: 'partial' })),
    );

    expect(error).toBeInstanceOf(UnreadableContentError);
    expect((error as Error).message).toContain(SHARD_KEY);
  });

  it('rejects a thread root that lacks storage_key', () => {
    const { storage_key: _omitted, ...root } = message_ref();
    const threads = { 'root-1': { root, replies: {} } };

    expect(error_of(() => assert_shard_shape(SHARD_KEY, shard_body({ threads })))).toBeInstanceOf(
      UnreadableContentError,
    );
  });

  it('rejects a kept version whose storage_key is mistyped', () => {
    const root = message_ref({
      kept: { storage_key: 7, checksum: 'c', size_bytes: 1, hosted: {} },
    });
    const threads = { 'root-1': { root, replies: {} } };

    expect(error_of(() => assert_shard_shape(SHARD_KEY, shard_body({ threads })))).toBeInstanceOf(
      UnreadableContentError,
    );
  });

  it('reports a newer-format shard as unsupported', () => {
    expect(
      error_of(() => assert_shard_shape(SHARD_KEY, shard_body({ format_version: 2 }))),
    ).toBeInstanceOf(UnsupportedFormatVersionError);
  });
});

describe('assert_cursor_shape', () => {
  it('accepts a cursor with its required fields', () => {
    expect(() => assert_cursor_shape(CURSOR_KEY, cursor_body())).not.toThrow();
  });

  it('rejects a cursor whose baseline_shard_key is missing, naming the key', () => {
    const { baseline_shard_key: _omitted, ...cursor } = cursor_body();

    const error = error_of(() => assert_cursor_shape(CURSOR_KEY, cursor));

    expect(error).toBeInstanceOf(UnreadableContentError);
    expect((error as Error).message).toContain(CURSOR_KEY);
  });

  it('rejects a cursor whose failed_roots is not an object', () => {
    expect(
      error_of(() => assert_cursor_shape(CURSOR_KEY, cursor_body({ failed_roots: [] }))),
    ).toBeInstanceOf(UnreadableContentError);
  });
});
