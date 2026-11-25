import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import {
  GraphUnavailableError,
  type TeamsChannelIndexEntry,
  type TeamsSnapshotIndex,
} from '@wisecom/atlas-types';
import {
  ATTEMPTS_PER_RETRY_CHAIN,
  GraphOutageFault,
  RETRY_BUDGET_SPAN_MS,
} from '@wisecom/atlas-types/testing/graph-outage-fault';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { channel_output, make_ports, TEAM_ID, TENANT_ID } from './backup-service-harness';

vi.mock('@wisecom/atlas-core/services/shared/run-object-lock', () => ({
  attach_run_retention: vi.fn(async (ctx: unknown) => ctx),
}));
vi.mock('@/services/backup/channel-backup-processor', () => ({ backup_channel: vi.fn() }));

/**
 * Issue #881: once one channel's Graph call spends its retry budget, the rest of the team's run
 * sends nothing more, keeps what it finished, and rejects with the outage.
 */

const CHANNELS = [{ id: 'channel-1' }, { id: 'channel-2' }, { id: 'channel-3' }];

function index_entry(channel_id: string, shard_key: string): TeamsChannelIndexEntry {
  return {
    channel_id,
    shard_key,
    shard_checksum: 'sum',
    thread_count: 0,
    message_count: 0,
    size_bytes: 0,
  };
}

function previous_index(channels: TeamsChannelIndexEntry[]): TeamsSnapshotIndex {
  return {
    team: { id: TEAM_ID, displayName: 'Team' },
    members: [],
    channels,
    created_at: new Date(0),
  } as unknown as TeamsSnapshotIndex;
}

/** One Graph per channel, so a test can tell which channels sent requests. */
function graph_per_channel(): Map<string, GraphOutageFault> {
  return new Map(CHANNELS.map((c) => [c.id, new GraphOutageFault()]));
}

function total_requests(graphs: Map<string, GraphOutageFault>): number {
  return [...graphs.values()].reduce((sum, g) => sum + g.requests, 0);
}

/** `completed` channels finish; every other channel reads Graph through the real retry loop. */
function back_up_channels_during_outage(
  graphs: Map<string, GraphOutageFault>,
  completed: readonly string[] = ['channel-1'],
): void {
  vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
    if (completed.includes(channel.id)) return channel_output(channel.id);
    await with_graph_retry(graphs.get(channel.id)!.send);
    return channel_output(channel.id);
  });
}

async function run_backup(concurrency: number) {
  const ports = make_ports({
    channels: CHANNELS,
    previous: previous_index([
      index_entry('channel-2', 'old-shard-2'),
      index_entry('channel-3', 'old-shard-3'),
    ]),
  });
  const outcome = ports.service.backup_team(TENANT_ID, TEAM_ID, { concurrency }).then(
    () => undefined,
    (err: unknown) => err,
  );
  await vi.advanceTimersByTimeAsync(3 * RETRY_BUDGET_SPAN_MS);
  return { ports, failure: await outcome };
}

describe('TeamsBackupService.backup_team during a Graph outage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(backup_channel).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spends one retry budget when channels run one at a time', async () => {
    const graphs = graph_per_channel();
    back_up_channels_during_outage(graphs);

    const { failure } = await run_backup(1);

    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect(total_requests(graphs)).toBe(ATTEMPTS_PER_RETRY_CHAIN);
    expect(graphs.get('channel-3')!.requests).toBe(0);
  });

  it('starts no chain for a queued channel once concurrent channels met the outage', async () => {
    const graphs = graph_per_channel();
    // channel-1 and channel-2 retry side by side; channel-3 waits for a free worker.
    back_up_channels_during_outage(graphs, []);
    const { failure } = await run_backup(2);

    expect(failure).toBeInstanceOf(GraphUnavailableError);
    expect(graphs.get('channel-3')!.requests).toBe(0);
    expect(total_requests(graphs)).toBeLessThanOrEqual(2 * ATTEMPTS_PER_RETRY_CHAIN);
    expect(Math.max(...[...graphs.values()].map((g) => g.requests))).toBe(ATTEMPTS_PER_RETRY_CHAIN);
  });

  it('commits the finished channel and keeps failed channels on their previous checkpoint', async () => {
    const graphs = graph_per_channel();
    back_up_channels_during_outage(graphs);

    const { ports } = await run_backup(1);

    const index = vi.mocked(ports.indexes.save).mock.calls[0]?.[1] as TeamsSnapshotIndex;
    expect(index.channels).toContainEqual(index_entry('channel-2', 'old-shard-2'));
    expect(index.channels).toContainEqual(index_entry('channel-3', 'old-shard-3'));
    expect(ports.shards.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channel_id: 'channel-1' }),
    );
    expect(ports.cursors.save).toHaveBeenCalledTimes(1);
    expect(ports.cursors.save).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channel_id: 'channel-1' }),
    );
    expect(ports.leases.held()).toBe(0);
  });

  it('still records a non-transient failure of one channel and completes the run', async () => {
    vi.mocked(backup_channel).mockImplementation(async (_scope, channel) => {
      if (channel.id === 'channel-2') throw new Error('channel is gone');
      return channel_output(channel.id);
    });

    const ports = make_ports({ channels: CHANNELS });
    const result = await ports.service.backup_team(TENANT_ID, TEAM_ID, { concurrency: 1 });

    expect(result.summary.errors).toEqual(['Channel channel-2: channel is gone']);
    expect(ports.cursors.save).toHaveBeenCalledTimes(2);
  });
});
