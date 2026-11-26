import { describe, expect, it, vi } from 'vitest';
import { OwnerLeaseLostError, type HeldOwnerLease } from '@wisecom/atlas-types';
import { forget_snapshot_summaries_or_warn } from '@/services/shared/snapshot-summary-pruner';
import { record_snapshot_summary } from '@/services/shared/snapshot-summary-writer';
import { logger } from '@/utils/logger';
import {
  LAYOUT,
  OWNER,
  counting_harness,
  fixture_manifest,
  store_manifest_only,
  summary_key,
} from './snapshot-summary.fixtures';

vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

async function recorded_snapshots(epochs: number[]) {
  const counted = counting_harness();
  for (const epoch of epochs) {
    const manifest = fixture_manifest(epoch);
    const key = await store_manifest_only(counted.harness, manifest);
    await record_snapshot_summary(
      counted.harness.ctx,
      LAYOUT,
      OWNER,
      LAYOUT.summarize(manifest, key),
    );
  }
  return counted.harness;
}

function stored_ids(harness: Awaited<ReturnType<typeof recorded_snapshots>>): string[] {
  const key = summary_key(OWNER);
  const stored = JSON.parse(harness.ctx.decrypt(harness.raw(key)!, key).toString('utf-8'));
  return stored.snapshots.map((row: { snapshot_id: string }) => row.snapshot_id);
}

describe('forget_snapshot_summaries_or_warn (#977)', () => {
  it('drops every named row in one summary rewrite', async () => {
    const harness = await recorded_snapshots([1000, 2000, 3000]);
    const put = vi.spyOn(harness.ctx.storage, 'put');

    await forget_snapshot_summaries_or_warn(harness.ctx, LAYOUT, OWNER, ['snap-1000', 'snap-2000']);

    expect(stored_ids(harness)).toEqual(['snap-3000']);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for no ids, or for ids the summary has no row for', async () => {
    const harness = await recorded_snapshots([1000]);
    const put = vi.spyOn(harness.ctx.storage, 'put');

    await forget_snapshot_summaries_or_warn(harness.ctx, LAYOUT, OWNER, []);
    await forget_snapshot_summaries_or_warn(harness.ctx, LAYOUT, OWNER, ['snap-9']);

    expect(put).not.toHaveBeenCalled();
  });

  it('logs a failed rewrite, and raises a lost lease', async () => {
    const harness = await recorded_snapshots([1000, 2000]);
    vi.spyOn(harness.ctx.storage, 'put').mockRejectedValueOnce(new Error('503 Slow Down'));
    await forget_snapshot_summaries_or_warn(harness.ctx, LAYOUT, OWNER, ['snap-1000']);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('1 removed'));

    const lost: HeldOwnerLease = {
      storage_key: 'lease',
      assert_held: () => {
        throw new OwnerLeaseLostError({ workload: 'onedrive', owner_id: OWNER }, 'taken over');
      },
      release: async () => undefined,
    };
    await expect(
      forget_snapshot_summaries_or_warn(harness.ctx, LAYOUT, OWNER, ['snap-1000'], lost),
    ).rejects.toBeInstanceOf(OwnerLeaseLostError);
  });
});
