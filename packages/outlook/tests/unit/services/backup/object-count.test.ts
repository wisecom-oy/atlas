import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxDeltaCursor, Manifest, ManifestEntry } from '@wisecom/atlas-types';
import { build_outlook_aggregates } from '@wisecom/atlas-core/services/catalog/outlook-snapshot-aggregates';
import { outlook_summary_row } from '@wisecom/atlas-types/testing/stub-outlook-manifest-chain';
import { latest_readable, readable_summaries } from '@wisecom/atlas-types/testing/readable-listing';
import {
  create_mailbox_sync_harness,
  make_delta,
  make_message,
  type MailboxSyncHarness,
} from './mailbox-sync.fixtures';

/**
 * Issue #711. The count a backup reported was the manifest's `total_objects`, a high-water mark of
 * single runs, so a full run without Recoverable Items printed its own size while the snapshot it
 * wrote still held the earlier run's messages. The count is now the snapshot's merged chain, the
 * figure `verify`, `restore -s` and `save -s` report.
 */
const OWNER = 'user@test.com';

function entry(object_id: string): ManifestEntry {
  return { object_id, storage_key: `data/${object_id}`, checksum: object_id, size_bytes: 1 };
}

/** A run that captured Recoverable Items: three live messages and two retained ones. */
function recoverable_items_run(): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: OWNER,
    snapshot_id: 'snap-1',
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    total_objects: 5,
    total_size_bytes: 5,
    delta_links: { 'folder-1': 'https://delta/1' },
    id_format: 'immutable',
    entries: ['a', 'b', 'c', 'rd1', 'rd2'].map(entry),
  };
}

/**
 * Backs the harness with a stored chain: saves land in it, the summary listing and the head read
 * answer from it, and the cursor round-trips, so consecutive runs build on each other.
 */
function back_with_chain(harness: MailboxSyncHarness, stored: Manifest[]): void {
  let cursor: MailboxDeltaCursor | undefined;
  vi.mocked(harness.mock_manifests.save).mockImplementation(async (_ctx, manifest) => {
    stored.unshift(manifest);
  });
  vi.mocked(harness.mock_manifests.find_latest_readable).mockImplementation(async () =>
    latest_readable(stored[0]),
  );
  vi.mocked(harness.mock_manifests.list_snapshot_summaries).mockImplementation(async () =>
    readable_summaries(
      stored.map((m) => ({ ...outlook_summary_row(m), aggregates: build_outlook_aggregates(m) })),
    ),
  );
  vi.mocked(harness.mock_cursors.save).mockImplementation(async (_ctx, saved) => {
    cursor = saved;
  });
  vi.mocked(harness.mock_cursors.load).mockImplementation(async () => cursor);
}

function deliver(harness: MailboxSyncHarness, ids: string[]): void {
  vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValueOnce(
    make_delta(ids.map((id) => make_message(id, `body ${id}`))),
  );
}

describe('the object count a backup reports (issue #711)', () => {
  let harness: MailboxSyncHarness;
  let stored: Manifest[];

  beforeEach(() => {
    harness = create_mailbox_sync_harness();
    stored = [recoverable_items_run()];
    back_with_chain(harness, stored);
  });

  it('counts the chain after a full run without Recoverable Items, then an incremental', async () => {
    deliver(harness, ['a', 'b', 'c']);
    const full = await harness.service.sync_mailbox('test-tenant', OWNER, { force_full: true });

    expect(full.manifest.total_objects).toBe(3);
    expect(full.snapshot.object_count).toBe(5);

    deliver(harness, ['d', 'e', 'a']);
    const incremental = await harness.service.sync_mailbox('test-tenant', OWNER);

    expect(incremental.mode).toBe('incremental');
    expect(incremental.snapshot.object_count).toBe(7);
  });

  it('falls when a run records removals', async () => {
    vi.mocked(harness.mock_connector.fetch_delta).mockResolvedValueOnce({
      ...make_delta([]),
      removed_ids: ['b', 'c'],
    });

    const result = await harness.service.sync_mailbox('test-tenant', OWNER);

    expect(result.snapshot.object_count).toBe(3);
  });

  it('reports the head chain on a run that captured nothing', async () => {
    deliver(harness, []);

    const result = await harness.service.sync_mailbox('test-tenant', OWNER);

    expect(harness.mock_manifests.save).not.toHaveBeenCalled();
    expect(result.snapshot.id).toBe('snap-1');
    expect(result.snapshot.object_count).toBe(5);
  });

  it('names a damaged manifest the count could not include', async () => {
    const damaged = `manifests/${OWNER}/snap-0.json`;
    vi.mocked(harness.mock_manifests.list_snapshot_summaries).mockResolvedValue({
      ...readable_summaries([]),
      unreadable_keys: [damaged],
    });
    deliver(harness, []);

    const result = await harness.service.sync_mailbox('test-tenant', OWNER, { force_full: true });

    expect(result.summary.unreadable_keys).toEqual([damaged]);
  });
});
