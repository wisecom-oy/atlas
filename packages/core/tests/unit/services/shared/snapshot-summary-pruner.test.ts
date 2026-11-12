import { describe, expect, it, vi } from 'vitest';
import { OwnerLeaseLostError, type HeldOwnerLease } from '@wisecom/atlas-types';
import {
  forget_snapshot_summary,
  forget_snapshot_summary_or_warn,
} from '@/services/shared/snapshot-summary-pruner';
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

/** Two manifests with rows, as two backups leave them. */
async function two_recorded_snapshots() {
  const counted = counting_harness();
  for (const epoch of [1000, 2000]) {
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

function stored_snapshot_ids(harness: Awaited<ReturnType<typeof two_recorded_snapshots>>) {
  const key = summary_key(OWNER);
  const stored = JSON.parse(harness.ctx.decrypt(harness.raw(key)!, key).toString('utf-8'));
  return stored.snapshots.map((row: { snapshot_id: string }) => row.snapshot_id);
}

describe('forget_snapshot_summary (#625)', () => {
  it('rewrites the summary without the removed snapshot, conditional on the ETag it read', async () => {
    const harness = await two_recorded_snapshots();
    const put = vi.spyOn(harness.ctx.storage, 'put');

    await forget_snapshot_summary(harness.ctx, LAYOUT, OWNER, 'snap-2000');

    expect(stored_snapshot_ids(harness)).toEqual(['snap-1000']);
    expect(put.mock.calls[0]?.[4]).toMatch(/^".+"$/);
    expect(put.mock.calls[0]?.[5]).toBe(false);
  });

  it('writes nothing when the summary has no row for the snapshot', async () => {
    const harness = await two_recorded_snapshots();
    const put = vi.spyOn(harness.ctx.storage, 'put');

    await forget_snapshot_summary(harness.ctx, LAYOUT, OWNER, 'snap-9999');

    expect(put).not.toHaveBeenCalled();
  });

  it('never creates a summary for an owner that has none', async () => {
    const { harness } = counting_harness();

    await forget_snapshot_summary(harness.ctx, LAYOUT, OWNER, 'snap-1000');

    expect(harness.raw(summary_key(OWNER))).toBeUndefined();
  });

  it('logs a failed prune instead of failing the delete that already removed the manifest', async () => {
    const harness = await two_recorded_snapshots();
    vi.spyOn(harness.ctx.storage, 'put').mockRejectedValue(new Error('503 Slow Down'));

    await expect(
      forget_snapshot_summary_or_warn(harness.ctx, LAYOUT, OWNER, 'snap-2000'),
    ).resolves.toBeUndefined();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('snap-2000'));
  });
});

/** A lease that was lost: every check throws, as after another operation took the owner over. */
function lost_lease(): HeldOwnerLease {
  return {
    storage_key: 'lease',
    assert_held: () => {
      throw new OwnerLeaseLostError({ workload: 'onedrive', owner_id: OWNER }, 'taken over');
    },
    release: async () => undefined,
  };
}

describe('forget_snapshot_summary under a lost lease (#623)', () => {
  it('writes nothing and raises when the lease was lost', async () => {
    const harness = await two_recorded_snapshots();
    const put = vi.spyOn(harness.ctx.storage, 'put');

    const forget = forget_snapshot_summary(harness.ctx, LAYOUT, OWNER, 'snap-2000', lost_lease());

    await expect(forget).rejects.toBeInstanceOf(OwnerLeaseLostError);
    expect(put).not.toHaveBeenCalled();
    expect(stored_snapshot_ids(harness)).toEqual(['snap-2000', 'snap-1000']);
  });

  it('does not swallow a lost lease as a summary warning', async () => {
    const harness = await two_recorded_snapshots();

    const forget = forget_snapshot_summary_or_warn(
      harness.ctx,
      LAYOUT,
      OWNER,
      'snap-2000',
      lost_lease(),
    );

    await expect(forget).rejects.toBeInstanceOf(OwnerLeaseLostError);
  });
});
