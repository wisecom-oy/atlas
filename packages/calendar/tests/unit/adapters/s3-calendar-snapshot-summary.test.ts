import { describe, expect, it, vi } from 'vitest';
import type { CalendarSnapshotManifest } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { save_full_snapshot_manifest } from '@wisecom/atlas-core/services/shared/full-snapshot-manifest-store';
import { CALENDAR_MANIFEST_LAYOUT } from '@/adapters/calendar-manifest-layout';
import { S3CalendarManifestRepository } from '@/adapters/s3-calendar-manifest-repository.adapter';
import {
  calendar_delta_cursor_key,
  calendar_manifest_key,
  calendar_summary_key,
} from '@/services/shared/storage-keys';

const MAILBOX = '00000000-0000-0000-0000-00000000abcd';
const SUMMARY_KEY = calendar_summary_key(MAILBOX);
const MANIFEST_PREFIX = `calendar/manifests/${MAILBOX}/`;

/** A calendar manifest of `events` events, created at `epoch` milliseconds. */
function manifest(epoch: number, events = 1): CalendarSnapshotManifest {
  return {
    id: `id-${epoch}`,
    tenant_id: 'tenant-1',
    mailbox_id: MAILBOX,
    snapshot_id: `cal-snap-${epoch}-abc`,
    created_at: new Date(epoch).toISOString(),
    total_events: events,
    total_size_bytes: 100 * events,
    calendars: [{ calendar_id: 'cal-1', display_name: 'Calendar', is_default: true }],
    entries: Array.from({ length: events }, (_, i) => ({
      event_id: `e-${epoch}-${i}`,
      calendar_id: 'cal-1',
      event_type: 'singleInstance',
      storage_key: `k-${epoch}-${i}`,
      checksum: `sum-${epoch}-${i}`,
      size_bytes: 100,
    })),
  };
}

async function three_snapshots() {
  const harness = in_memory_tenant_context();
  const repo = new S3CalendarManifestRepository();
  await repo.save(harness.ctx, manifest(1000, 1));
  await repo.save(harness.ctx, manifest(2000, 2));
  await repo.save(harness.ctx, manifest(3000, 3));
  const get = vi.spyOn(harness.ctx.storage, 'get');
  const manifest_reads = (): string[] =>
    get.mock.calls.map(([key]) => key).filter((key) => key.startsWith('calendar/manifests/'));
  return { harness, repo, manifest_reads };
}

/** The snapshot ids of a listing, in the order it returned them. */
function ids(summaries: readonly { snapshot_id: string }[]): string[] {
  return summaries.map((s) => s.snapshot_id);
}

type Harness = Awaited<ReturnType<typeof three_snapshots>>['harness'];

/** An encrypted summary document with no rows, naming `owner_id` and `format_version`. */
function encrypted_summary(harness: Harness, owner_id: string, format_version: number): Buffer {
  const document = {
    format_version,
    owner_id,
    updated_at: new Date().toISOString(),
    snapshots: [],
  };
  return harness.ctx.encrypt(Buffer.from(JSON.stringify(document)), SUMMARY_KEY);
}

describe('Calendar snapshot summary index (#727)', () => {
  it('records every saved snapshot beside the cursor, encrypted', async () => {
    const { harness } = await three_snapshots();

    const raw = harness.raw(SUMMARY_KEY)!;
    expect(raw.toString('utf-8')).not.toContain('cal-snap-');
    const stored = JSON.parse(harness.ctx.decrypt(raw, SUMMARY_KEY).toString('utf-8'));
    expect(stored).toMatchObject({ format_version: 1, owner_id: MAILBOX });
    expect(stored.snapshots).toHaveLength(3);
    expect(stored.snapshots).toContainEqual(
      expect.objectContaining({
        snapshot_id: 'cal-snap-3000-abc',
        mailbox_id: MAILBOX,
        total_events: 3,
      }),
    );
  });

  it('lists with one storage listing and one summary read, decrypting no manifest', async () => {
    const { harness, repo, manifest_reads } = await three_snapshots();
    const list = vi.spyOn(harness.ctx.storage, 'list');
    const get_with_etag = vi.spyOn(harness.ctx.storage, 'get_with_etag');

    const listing = await repo.list_snapshot_summaries(harness.ctx, MAILBOX);

    expect(ids(listing.summaries)).toEqual([
      'cal-snap-3000-abc',
      'cal-snap-2000-abc',
      'cal-snap-1000-abc',
    ]);
    expect(listing.summaries[1]).toMatchObject({
      entry_count: 2,
      total_events: 2,
      total_size_bytes: 200,
      mailbox_id: MAILBOX,
    });
    expect(listing.unreadable_keys).toEqual([]);
    expect(list.mock.calls).toEqual([[MANIFEST_PREFIX]]);
    expect(get_with_etag.mock.calls).toEqual([[SUMMARY_KEY]]);
    expect(manifest_reads()).toEqual([]);
  });

  it('answers as the manifests do when the summary is missing, and never writes it back', async () => {
    const { harness, repo, manifest_reads } = await three_snapshots();
    const from_manifests = await repo.list_readable_snapshots_by_mailbox(harness.ctx, MAILBOX);
    harness.remove(SUMMARY_KEY);
    const reads_before = manifest_reads().length;

    const listing = await repo.list_snapshot_summaries(harness.ctx, MAILBOX);

    expect(ids(listing.summaries)).toEqual(from_manifests.manifests.map((m) => m.snapshot_id));
    expect(listing.summaries.map((s) => s.total_events)).toEqual(
      from_manifests.manifests.map((m) => m.total_events),
    );
    expect(manifest_reads().length - reads_before).toBe(3);
    expect(harness.raw(SUMMARY_KEY)).toBeUndefined();
  });

  it.each([
    ['bytes that do not decrypt', () => Buffer.from('damaged')],
    [
      'a document that names another mailbox',
      (h: Harness) => encrypted_summary(h, 'someone-else', 1),
    ],
    ['an unknown format version', (h: Harness) => encrypted_summary(h, MAILBOX, 99)],
  ])('answers as the manifests do when the summary is damaged: %s', async (_label, damage) => {
    const { harness, repo } = await three_snapshots();
    const from_manifests = await repo.list_readable_snapshots_by_mailbox(harness.ctx, MAILBOX);
    harness.set_raw(SUMMARY_KEY, damage(harness));

    const listing = await repo.list_snapshot_summaries(harness.ctx, MAILBOX);

    expect(ids(listing.summaries)).toEqual(from_manifests.manifests.map((m) => m.snapshot_id));
    expect(listing.unreadable_keys).toEqual([]);
  });

  it('drops the row of a deleted snapshot, and decrypts a manifest that has no row', async () => {
    const { harness, repo, manifest_reads } = await three_snapshots();
    // `delete -s` removes the manifest and no row (the summary is not rewritten without the key).
    harness.remove(calendar_manifest_key(MAILBOX, 'cal-snap-3000-abc'));
    // A manifest stored without its row, as after a failed summary write.
    await save_full_snapshot_manifest(harness.ctx, CALENDAR_MANIFEST_LAYOUT, manifest(4000));
    const reads_before = manifest_reads().length;

    const listing = await repo.list_snapshot_summaries(harness.ctx, MAILBOX);

    expect(ids(listing.summaries)).toEqual([
      'cal-snap-4000-abc',
      'cal-snap-2000-abc',
      'cal-snap-1000-abc',
    ]);
    expect(manifest_reads().length - reads_before).toBe(1);
  });

  it('names a rowless manifest that fails to decrypt and keeps the rest', async () => {
    const { harness, repo } = await three_snapshots();
    await save_full_snapshot_manifest(harness.ctx, CALENDAR_MANIFEST_LAYOUT, manifest(4000));
    const damaged = calendar_manifest_key(MAILBOX, 'cal-snap-4000-abc');
    harness.set_raw(damaged, Buffer.from('damaged'));

    const listing = await repo.list_snapshot_summaries(harness.ctx, MAILBOX);

    expect(ids(listing.summaries)).toEqual([
      'cal-snap-3000-abc',
      'cal-snap-2000-abc',
      'cal-snap-1000-abc',
    ]);
    expect(listing.unreadable_keys).toEqual([damaged]);
  });

  it('lists the same snapshots with the cursor beside the summary', async () => {
    const { harness, repo } = await three_snapshots();
    const before = ids((await repo.list_snapshot_summaries(harness.ctx, MAILBOX)).summaries);
    harness.set_raw(
      calendar_delta_cursor_key(MAILBOX),
      harness.ctx.encrypt(Buffer.from('{}'), calendar_delta_cursor_key(MAILBOX)),
    );

    const after = ids((await repo.list_snapshot_summaries(harness.ctx, MAILBOX)).summaries);

    expect(after).toEqual(before);
  });

  it('lists nothing for a mailbox that has no snapshots', async () => {
    const harness = in_memory_tenant_context();
    const repo = new S3CalendarManifestRepository();

    const listing = await repo.list_snapshot_summaries(harness.ctx, MAILBOX);

    expect(listing).toEqual({ summaries: [], unreadable_keys: [] });
  });
});
