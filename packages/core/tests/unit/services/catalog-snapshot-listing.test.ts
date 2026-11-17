import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import type { CatalogService } from '@/services/catalog/catalog.service';
import type { ManifestEntry, ManifestRepository } from '@wisecom/atlas-types';
import { build_catalog_harness, make_manifest, summary_listing } from './catalog-service.fixtures';

function entries(...object_ids: string[]): ManifestEntry[] {
  return object_ids.map((object_id) => ({
    object_id,
    storage_key: `data/${object_id}`,
    checksum: object_id,
    size_bytes: 1,
  }));
}

// Issue #711: the high-water mark `total_objects` of a full run without Recoverable Items stays at
// that run's size while the chain still holds the earlier run's messages.
const runs = [
  make_manifest({
    snapshot_id: 's3',
    created_at: new Date('2026-03-03'),
    total_objects: 3,
    entries: entries('d', 'e'),
  }),
  make_manifest({
    snapshot_id: 's2',
    created_at: new Date('2026-03-02'),
    total_objects: 3,
    entries: entries('a', 'b', 'c'),
  }),
  make_manifest({
    snapshot_id: 's1',
    created_at: new Date('2026-03-01'),
    total_objects: 5,
    entries: entries('a', 'b', 'c', 'rd1', 'rd2'),
  }),
];

describe('CatalogService.list_snapshot_summaries object counts (issue #711)', () => {
  let mock_manifests: ManifestRepository;
  let service: CatalogService;

  beforeEach(() => {
    ({ service, mock_manifests } = build_catalog_harness());
    vi.mocked(mock_manifests.list_snapshot_summaries).mockResolvedValue(summary_listing(runs));
  });

  it('gives each snapshot the message count of the chain it heads', async () => {
    const listed = await service.list_snapshot_summaries('t', 'user@test.com');

    expect(listed.map((row) => [row.snapshot_id, row.object_count])).toEqual([
      ['s3', 7],
      ['s2', 5],
      ['s1', 5],
    ]);
  });

  it('keeps the stored high-water mark beside the count', async () => {
    const listed = await service.list_snapshot_summaries('t', 'user@test.com');

    expect(listed.map((row) => row.total_objects)).toEqual([3, 3, 5]);
  });

  it('matches the mailbox overview for the newest snapshot', async () => {
    vi.mocked(mock_manifests.list_all_snapshot_summaries).mockResolvedValue(summary_listing(runs));

    const [mailbox] = await service.list_mailboxes('t');
    const [newest] = await service.list_snapshot_summaries('t', 'user@test.com');

    expect(newest!.object_count).toBe(mailbox!.total_objects);
  });
});
