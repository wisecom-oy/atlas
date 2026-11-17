import { describe, expect, it } from 'vitest';
import type { TeamsGraphResource } from '@wisecom/atlas-types';
import { build_channel_run_reports } from '@/services/backup/backup-run-report';
import type { ChannelRunRecord, ChannelRunState } from '@/services/backup/channel-run-loop';

const CHANNELS: TeamsGraphResource[] = [
  { id: 'channel-1', displayName: 'One' },
  { id: 'channel-2', displayName: 'Two' },
  { id: 'channel-3', displayName: 'Three' },
];

function record(overrides: Partial<ChannelRunRecord>): ChannelRunRecord {
  return {
    outcome: 'completed',
    read_mode: 'delta',
    resumed_from_checkpoint: false,
    elapsed_ms: 40,
    output: undefined,
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function state_with(records: Array<[string, ChannelRunRecord]>): ChannelRunState {
  return {
    results: new Map(),
    records: new Map(records),
    errors: [],
    warnings: [],
    attempted: records.length,
    interrupted: false,
  };
}

describe('build_channel_run_reports', () => {
  it('reports one row per channel in listing order, marking unstarted channels', () => {
    const state = state_with([
      ['channel-2', record({ outcome: 'incomplete' })],
      ['channel-1', record({ outcome: 'completed', read_mode: 'full' })],
    ]);

    const rows = build_channel_run_reports(CHANNELS, state, new Map());

    expect(rows.map((row) => [row.channel_id, row.outcome])).toEqual([
      ['channel-1', 'completed'],
      ['channel-2', 'incomplete'],
      ['channel-3', 'not_started'],
    ]);
    expect(rows[0]).toMatchObject({ read_mode: 'full', elapsed_ms: 40 });
  });

  it('gives unstarted channels zero time, zero roots, and no read mode', () => {
    const rows = build_channel_run_reports(CHANNELS.slice(2), state_with([]), new Map());

    expect(rows).toEqual([
      {
        channel_id: 'channel-3',
        outcome: 'not_started',
        read_mode: undefined,
        roots_applied: 0,
        resumed_from_checkpoint: false,
        elapsed_ms: 0,
      },
    ]);
  });

  it('takes roots applied and the resume flag from the run, per channel', () => {
    const state = state_with([['channel-1', record({ resumed_from_checkpoint: true })]]);
    const rows = build_channel_run_reports(
      CHANNELS.slice(0, 2),
      state,
      new Map([['channel-1', 7]]),
    );

    expect(rows[0]).toMatchObject({ roots_applied: 7, resumed_from_checkpoint: true });
    expect(rows[1]).toMatchObject({ roots_applied: 0, resumed_from_checkpoint: false });
  });
});
