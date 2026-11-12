import { describe, expect, it } from 'vitest';
import {
  find_latest_readable_by_summary,
  list_snapshot_summaries,
  list_tenant_snapshot_summaries,
} from '@/services/shared/snapshot-summary-reader';
import { record_snapshot_summary } from '@/services/shared/snapshot-summary-writer';
import {
  LAYOUT,
  OTHER_OWNER,
  OWNER,
  counting_harness,
  damage,
  fixture_manifest,
  manifest_key,
  store_manifest_only,
  summary_key,
  type FixtureManifest,
} from './snapshot-summary.fixtures';
import type { InMemoryTenantContext } from '@wisecom/atlas-types/testing/in-memory-tenant-context';

/** Stores a manifest and records it in the summary, as a backup does. */
async function back_up(harness: InMemoryTenantContext, manifest: FixtureManifest): Promise<void> {
  const key = await store_manifest_only(harness, manifest);
  await record_snapshot_summary(
    harness.ctx,
    LAYOUT,
    manifest.owner_id,
    LAYOUT.summarize(manifest, key),
  );
}

describe('list_snapshot_summaries (#625)', () => {
  it('answers from the summary without decrypting any manifest', async () => {
    const { harness, manifest_reads } = counting_harness();
    for (const epoch of [1000, 2000, 3000]) await back_up(harness, fixture_manifest(epoch));
    const before = manifest_reads().length;

    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);

    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual([
      'snap-3000',
      'snap-2000',
      'snap-1000',
    ]);
    expect(listing.summaries[0]).toMatchObject({
      entry_count: 2,
      total_files: 2,
      total_size_bytes: 3000,
    });
    expect(listing.summaries[0]?.created_at).toEqual(new Date(3000));
    expect(manifest_reads().length - before).toBe(0);
  });

  it('decrypts every manifest when the owner has no summary yet, as before the index existed', async () => {
    const { harness, manifest_reads } = counting_harness();
    await store_manifest_only(harness, fixture_manifest(1000));
    await store_manifest_only(harness, fixture_manifest(2000));

    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);

    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual(['snap-2000', 'snap-1000']);
    expect(manifest_reads()).toHaveLength(2);
    expect(harness.raw(summary_key(OWNER))).toBeUndefined();
  });

  it('decrypts only the manifest a failed summary write left without a row', async () => {
    const { harness, manifest_reads } = counting_harness();
    await back_up(harness, fixture_manifest(1000));
    const rowless = await store_manifest_only(harness, fixture_manifest(2000));
    const before = manifest_reads().length;

    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);

    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual(['snap-2000', 'snap-1000']);
    expect(manifest_reads().slice(before)).toEqual([rowless]);
  });

  it('drops the row of a manifest that was deleted or quarantined', async () => {
    const { harness } = counting_harness();
    await back_up(harness, fixture_manifest(1000));
    await back_up(harness, fixture_manifest(2000));
    harness.remove(manifest_key(OWNER, 'snap-2000'));

    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);

    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual(['snap-1000']);
  });

  it('names a rowless manifest that fails to decrypt and keeps the rest', async () => {
    const { harness } = counting_harness();
    await back_up(harness, fixture_manifest(1000));
    const rowless = await store_manifest_only(harness, fixture_manifest(2000));
    damage(harness, rowless);

    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);

    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual(['snap-1000']);
    expect(listing.unreadable_keys).toEqual([rowless]);
  });

  it('falls back to decrypting the manifests when the summary itself is damaged', async () => {
    const { harness, manifest_reads } = counting_harness();
    await back_up(harness, fixture_manifest(1000));
    damage(harness, summary_key(OWNER));
    const before = manifest_reads().length;

    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);

    expect(listing.summaries.map((s) => s.snapshot_id)).toEqual(['snap-1000']);
    expect(manifest_reads().length - before).toBe(1);
  });

  it('ignores a summary that names another owner, even one that decrypts at this key', async () => {
    const { harness } = counting_harness();
    await back_up(harness, fixture_manifest(1000, OTHER_OWNER));
    const foreign = harness.ctx.decrypt(
      harness.raw(summary_key(OTHER_OWNER))!,
      summary_key(OTHER_OWNER),
    );
    const key = summary_key(OWNER);
    await harness.ctx.storage.put(key, harness.ctx.encrypt(foreign, key));
    await store_manifest_only(harness, fixture_manifest(5000));

    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);

    expect(listing.summaries.map((s) => `${s.owner_id}/${s.snapshot_id}`)).toEqual([
      `${OWNER}/snap-5000`,
    ]);
  });

  it('drops a row whose manifest key is not the one its owner and snapshot build', async () => {
    const { harness, manifest_reads } = counting_harness();
    await back_up(harness, fixture_manifest(1000));
    const key = summary_key(OWNER);
    const document = JSON.parse(harness.ctx.decrypt(harness.raw(key)!, key).toString('utf-8'));
    document.snapshots[0].manifest_key = manifest_key(OTHER_OWNER, 'snap-1000');
    await harness.ctx.storage.put(
      key,
      harness.ctx.encrypt(Buffer.from(JSON.stringify(document)), key),
    );
    const before = manifest_reads().length;

    const listing = await list_snapshot_summaries(harness.ctx, LAYOUT, OWNER);

    expect(listing.summaries.map((s) => s.manifest_key)).toEqual([
      manifest_key(OWNER, 'snap-1000'),
    ]);
    expect(manifest_reads().length - before).toBe(1);
  });
});

describe('find_latest_readable_by_summary (#625)', () => {
  it('decrypts only the newest manifest', async () => {
    const { harness, manifest_reads } = counting_harness();
    for (const epoch of [1000, 2000, 3000]) await back_up(harness, fixture_manifest(epoch));
    const before = manifest_reads().length;

    const latest = await find_latest_readable_by_summary(harness.ctx, LAYOUT, OWNER);

    expect(latest.manifest?.snapshot_id).toBe('snap-3000');
    expect(manifest_reads().slice(before)).toEqual([manifest_key(OWNER, 'snap-3000')]);
  });

  it('names a damaged newest manifest and returns the next one', async () => {
    const { harness } = counting_harness();
    await back_up(harness, fixture_manifest(1000));
    await back_up(harness, fixture_manifest(2000));
    damage(harness, manifest_key(OWNER, 'snap-2000'));

    const latest = await find_latest_readable_by_summary(harness.ctx, LAYOUT, OWNER);

    expect(latest).toMatchObject({
      manifest: { snapshot_id: 'snap-1000' },
      unreadable_keys: [manifest_key(OWNER, 'snap-2000')],
    });
  });

  it('reports no manifest for an owner never backed up', async () => {
    const { harness } = counting_harness();

    await expect(find_latest_readable_by_summary(harness.ctx, LAYOUT, OWNER)).resolves.toEqual({
      manifest: undefined,
      unreadable_keys: [],
    });
  });
});

describe('list_tenant_snapshot_summaries (#625)', () => {
  it('reads each owner from its own summary, newest first across owners', async () => {
    const { harness, manifest_reads } = counting_harness();
    await back_up(harness, fixture_manifest(1000));
    await back_up(harness, fixture_manifest(3000, OTHER_OWNER));
    await store_manifest_only(harness, fixture_manifest(2000));
    const before = manifest_reads().length;

    const listing = await list_tenant_snapshot_summaries(harness.ctx, LAYOUT);

    expect(listing.summaries.map((s) => `${s.owner_id}/${s.snapshot_id}`)).toEqual([
      `${OTHER_OWNER}/snap-3000`,
      `${OWNER}/snap-2000`,
      `${OWNER}/snap-1000`,
    ]);
    expect(manifest_reads().slice(before)).toEqual([manifest_key(OWNER, 'snap-2000')]);
  });
});
