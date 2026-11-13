import { describe, expect, it, vi } from 'vitest';
import type {
  AttachmentEntry,
  Manifest,
  ManifestEntry,
  OutlookSnapshotSummary,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { aggregate_mailbox_stats } from '@wisecom/atlas-core/services/stats/stats-aggregator';
import {
  build_outlook_aggregates,
  hash_object_id,
  parse_outlook_aggregates,
} from '@/adapters/outlook-snapshot-aggregates';
import {
  OUTLOOK_SUMMARY_LAYOUT,
  outlook_summary_key,
  summarize_outlook_manifest,
} from '@/adapters/outlook-snapshot-summary-layout';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';

const OWNER = '00000000-0000-0000-0000-00000000abcd';

function attachment(size_bytes: number): AttachmentEntry {
  return {
    attachment_id: `att-${size_bytes}`,
    name: 'file.pdf',
    content_type: 'application/pdf',
    size_bytes,
    storage_key: `att-key-${size_bytes}`,
    checksum: 'c',
    is_inline: false,
  };
}

function entry(
  object_id: string,
  size_bytes: number,
  extra: Partial<ManifestEntry> = {},
): ManifestEntry {
  return {
    object_id,
    storage_key: `key-${object_id}`,
    checksum: `sum-${object_id}`,
    size_bytes,
    ...extra,
  };
}

/** One run's manifest: two folders, attachments, a repeated message ID and a folderless entry. */
function sample_manifest(snapshot_id = 'snap-2', created_at = '2026-03-02T10:00:00Z'): Manifest {
  return {
    id: `id-${snapshot_id}`,
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    snapshot_id,
    created_at: new Date(created_at),
    total_objects: 3,
    total_size_bytes: 0,
    delta_links: {},
    id_format: 'immutable',
    removed_object_ids: ['old-1', 'old-1', 'old-2'],
    entries: [
      entry('m1', 100, { folder_id: 'inbox', attachments: [attachment(40), attachment(10)] }),
      entry('m2', 200, { folder_id: 'sent' }),
      entry('m3', 50),
      entry('m1', 100, { folder_id: 'inbox' }),
    ],
  };
}

describe('Outlook snapshot aggregates (#726)', () => {
  it('records the totals the stats aggregator computes from the same manifest', () => {
    const manifest = sample_manifest();

    const row = build_outlook_aggregates(manifest);
    const mailbox = aggregate_mailbox_stats(OWNER, [manifest]);

    expect(row.entry_size_bytes).toBe(mailbox.total_size_bytes);
    expect(row.attachment_count).toBe(mailbox.attachment_count);
    expect(row.attachment_size_bytes).toBe(mailbox.attachment_size_bytes);
    expect(row.folders).toEqual(
      mailbox.folders.map((folder) => ({
        folder_id: folder.folder_id,
        message_count: folder.message_count,
        total_size_bytes: folder.total_size_bytes,
        attachment_count: folder.attachment_count,
        attachment_size_bytes: folder.attachment_size_bytes,
      })),
    );
  });

  it('keeps hashed IDs of the distinct entries and of the removals, never the IDs themselves', () => {
    const row = build_outlook_aggregates(sample_manifest());

    expect(hash_object_id('m1')).toHaveLength(16);
    expect(row.object_ids).toBe(['m1', 'm2', 'm3'].map(hash_object_id).join(''));
    expect(row.removed_ids).toBe(['old-1', 'old-2'].map(hash_object_id).join(''));
    expect(row.object_ids).not.toContain('m1');
  });

  it('reads back exactly what it wrote, and reads an absent field as absent', () => {
    const row = build_outlook_aggregates(sample_manifest());

    expect(parse_outlook_aggregates(JSON.parse(JSON.stringify(row)))).toEqual(row);
    expect(parse_outlook_aggregates(undefined)).toBeUndefined();
  });

  it('rejects a malformed field so its manifest is decrypted instead of the row trusted', () => {
    const row = JSON.parse(JSON.stringify(build_outlook_aggregates(sample_manifest())));

    expect(
      parse_outlook_aggregates({ ...row, object_ids: row.object_ids.slice(0, 15) }),
    ).toBeNull();
    expect(parse_outlook_aggregates({ ...row, removed_ids: '+/' })).toBeNull();
    expect(parse_outlook_aggregates({ ...row, entry_size_bytes: -1 })).toBeNull();
    expect(parse_outlook_aggregates({ ...row, folders: [{ folder_id: 'inbox' }] })).toBeNull();
    expect(parse_outlook_aggregates('not a record')).toBeNull();
  });

  it('marks a row written before the aggregates existed as not current', () => {
    const summary = summarize_outlook_manifest(sample_manifest(), 'manifests/x/snap-2.json');
    const legacy = Object.fromEntries(
      Object.entries(summary).filter(([field]) => field !== 'aggregates'),
    ) as OutlookSnapshotSummary;

    expect(OUTLOOK_SUMMARY_LAYOUT.is_current?.(summary)).toBe(true);
    expect(OUTLOOK_SUMMARY_LAYOUT.is_current?.(legacy)).toBe(false);
  });

  it('decrypts the manifest of a legacy row once and repairs the row on the next write', async () => {
    const harness = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    const summary_key = outlook_summary_key(OWNER);
    await repo.save(harness.ctx, sample_manifest('snap-1', '2026-03-01T10:00:00Z'));
    await repo.save(harness.ctx, sample_manifest('snap-2', '2026-03-02T10:00:00Z'));
    const stored = JSON.parse(
      harness.ctx.decrypt(harness.raw(summary_key)!, summary_key).toString('utf-8'),
    );
    const legacy_rows = stored.snapshots.map((row: Record<string, unknown>) => {
      const { aggregates: _dropped, ...rest } = row;
      return rest;
    });
    harness.set_raw(
      summary_key,
      harness.ctx.encrypt(
        Buffer.from(JSON.stringify({ ...stored, snapshots: legacy_rows })),
        summary_key,
      ),
    );
    const get = vi.spyOn(harness.ctx.storage, 'get');
    const manifest_reads = (): string[] =>
      get.mock.calls.map(([key]) => key).filter((key) => key.startsWith('manifests/'));

    const listing = await repo.list_snapshot_summaries(harness.ctx, OWNER);
    expect(listing.summaries.every((s) => s.aggregates !== undefined)).toBe(true);
    expect(manifest_reads()).toHaveLength(2);

    get.mockClear();
    await repo.save(harness.ctx, sample_manifest('snap-3', '2026-03-03T10:00:00Z'));
    get.mockClear();
    const repaired = await repo.list_snapshot_summaries(harness.ctx, OWNER);
    expect(repaired.summaries).toHaveLength(3);
    expect(manifest_reads()).toEqual([]);
  });
});
