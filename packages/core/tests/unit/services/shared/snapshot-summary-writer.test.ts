import { describe, expect, it, vi } from 'vitest';
import { list_snapshot_summaries } from '@/services/shared/snapshot-summary-reader';
import {
  record_snapshot_summary,
  record_snapshot_summary_or_warn,
} from '@/services/shared/snapshot-summary-writer';
import {
  LAYOUT,
  OWNER,
  counting_harness,
  fixture_manifest,
  manifest_key,
  store_manifest_only,
  summary_key,
} from './snapshot-summary.fixtures';

vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function precondition_failed(): Error {
  return Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
}

describe('record_snapshot_summary (#625)', () => {
  it('creates the summary create-only, then rewrites it conditional on the ETag it read', async () => {
    const { harness } = counting_harness();
    const put = vi.spyOn(harness.ctx.storage, 'put');
    const first = fixture_manifest(1000);
    const second = fixture_manifest(2000);

    const first_key = await store_manifest_only(harness, first);
    await record_snapshot_summary(harness.ctx, LAYOUT, OWNER, LAYOUT.summarize(first, first_key));
    const second_key = await store_manifest_only(harness, second);
    await record_snapshot_summary(harness.ctx, LAYOUT, OWNER, LAYOUT.summarize(second, second_key));

    const summary_puts = put.mock.calls.filter(([key]) => key === summary_key(OWNER));
    expect(summary_puts[0]?.slice(4)).toEqual([undefined, true]);
    expect(summary_puts[1]?.[4]).toMatch(/^".+"$/);
    expect(summary_puts[1]?.[5]).toBe(false);
  });

  it('seeds rows for manifests written before the index existed, once', async () => {
    const { harness, manifest_reads } = counting_harness();
    await store_manifest_only(harness, fixture_manifest(1000));
    await store_manifest_only(harness, fixture_manifest(2000));
    const latest = fixture_manifest(3000);
    const latest_key = await store_manifest_only(harness, latest);

    await record_snapshot_summary(harness.ctx, LAYOUT, OWNER, LAYOUT.summarize(latest, latest_key));
    const before = manifest_reads().length;
    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);

    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual([
      'snap-3000',
      'snap-2000',
      'snap-1000',
    ]);
    expect(manifest_reads().length - before).toBe(0);
  });

  it('drops rows of manifests removed since the last write', async () => {
    const { harness } = counting_harness();
    const old = fixture_manifest(1000);
    const old_key = await store_manifest_only(harness, old);
    await record_snapshot_summary(harness.ctx, LAYOUT, OWNER, LAYOUT.summarize(old, old_key));
    harness.remove(old_key);
    const next = fixture_manifest(2000);
    const next_key = await store_manifest_only(harness, next);

    await record_snapshot_summary(harness.ctx, LAYOUT, OWNER, LAYOUT.summarize(next, next_key));

    const key = summary_key(OWNER);
    const stored = JSON.parse(harness.ctx.decrypt(harness.raw(key)!, key).toString('utf-8'));
    expect(stored.snapshots.map((row: { snapshot_id: string }) => row.snapshot_id)).toEqual([
      'snap-2000',
    ]);
  });

  it('reconciles again once when a concurrent writer changed the summary', async () => {
    const { harness } = counting_harness();
    const manifest = fixture_manifest(1000);
    const key = await store_manifest_only(harness, manifest);
    const real_put = harness.ctx.storage.put.bind(harness.ctx.storage);
    const put = vi
      .spyOn(harness.ctx.storage, 'put')
      .mockRejectedValueOnce(precondition_failed())
      .mockImplementation(real_put);

    await record_snapshot_summary(harness.ctx, LAYOUT, OWNER, LAYOUT.summarize(manifest, key));

    expect(put).toHaveBeenCalledTimes(2);
    expect(harness.raw(summary_key(OWNER))).toBeDefined();
  });

  it('gives up after a second conflict rather than retrying without bound', async () => {
    const { harness } = counting_harness();
    const manifest = fixture_manifest(1000);
    const key = await store_manifest_only(harness, manifest);
    const put = vi.spyOn(harness.ctx.storage, 'put').mockRejectedValue(precondition_failed());

    await expect(
      record_snapshot_summary(harness.ctx, LAYOUT, OWNER, LAYOUT.summarize(manifest, key)),
    ).rejects.toThrow(/PreconditionFailed/);
    expect(put).toHaveBeenCalledTimes(2);
  });
});

describe('record_snapshot_summary_or_warn (#625)', () => {
  it('logs a failed summary write instead of failing the backup that stored the manifest', async () => {
    const { harness } = counting_harness();
    const manifest = fixture_manifest(1000);
    const key = await store_manifest_only(harness, manifest);
    vi.spyOn(harness.ctx.storage, 'put').mockRejectedValue(new Error('503 Slow Down'));

    await expect(
      record_snapshot_summary_or_warn(harness.ctx, LAYOUT, OWNER, LAYOUT.summarize(manifest, key)),
    ).resolves.toBeUndefined();

    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);
    expect(listing.summaries.map((s) => s.manifest_key)).toEqual([
      manifest_key(OWNER, 'snap-1000'),
    ]);
  });
});
