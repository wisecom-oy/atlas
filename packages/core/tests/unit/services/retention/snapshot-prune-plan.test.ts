import { describe, expect, it } from 'vitest';
import type { SnapshotSummary } from '@wisecom/atlas-types';
import { baseline_chain_keys, plan_snapshot_prune } from '@/services/retention/snapshot-prune-plan';

function row(snapshot_id: string, iso: string): SnapshotSummary {
  return {
    snapshot_id,
    created_at: new Date(iso),
    manifest_key: `m/${snapshot_id}.json`,
    entry_count: 1,
    total_size_bytes: 1,
  };
}

const ROWS = [
  row('a', '2026-01-01T00:00:00Z'),
  row('b', '2026-01-02T00:00:00Z'),
  row('c', '2026-01-03T00:00:00Z'),
];

const ids = (rows: readonly SnapshotSummary[]): string[] => rows.map((r) => r.snapshot_id);

describe('plan_snapshot_prune', () => {
  it('prunes snapshots strictly before the cut-off and keeps one taken exactly at it', () => {
    const plan = plan_snapshot_prune(ROWS, new Date('2026-01-02T00:00:00Z'));
    expect(ids(plan.pruned)).toEqual(['a']);
    expect(ids(plan.baselines)).toEqual(['b']);
    expect(ids(plan.kept)).toEqual(['c', 'b']);
  });

  it('keeps the newest snapshot even when it is older than the cut-off', () => {
    const plan = plan_snapshot_prune(ROWS, new Date('2027-01-01T00:00:00Z'));
    expect(ids(plan.pruned)).toEqual(['b', 'a']);
    expect(ids(plan.kept)).toEqual(['c']);
    expect(ids(plan.baselines)).toEqual(['c']);
  });

  it('plans nothing when no snapshot is older than the cut-off, or there are none', () => {
    expect(plan_snapshot_prune(ROWS, new Date('2025-01-01T00:00:00Z'))).toEqual({
      pruned: [],
      baselines: [],
      kept: [...ROWS].reverse(),
    });
    expect(plan_snapshot_prune([], new Date())).toEqual({ pruned: [], baselines: [], kept: [] });
  });

  it('makes every snapshot that shares the oldest kept time a baseline, each folding the others', () => {
    const tied = [...ROWS, row('b2', '2026-01-02T00:00:00Z')];
    const plan = plan_snapshot_prune(tied, new Date('2026-01-02T00:00:00Z'));
    expect(ids(plan.baselines).sort()).toEqual(['b', 'b2']);
    const b = plan.baselines.find((r) => r.snapshot_id === 'b')!;
    expect(baseline_chain_keys(plan, b)).toEqual(['m/b.json', 'm/b2.json', 'm/a.json']);
  });
});
