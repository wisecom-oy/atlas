import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'reflect-metadata';
import type { CatalogService } from '@/services/catalog/catalog.service';
import type { ManifestRepository, TenantContext } from '@wisecom/atlas-types';
import { build_catalog_harness, make_manifest } from './catalog-service.fixtures';

describe('CatalogService', () => {
  let mock_manifests: ManifestRepository;
  let mock_context: TenantContext;
  let service: CatalogService;

  beforeEach(() => {
    ({ service, mock_manifests, mock_context } = build_catalog_harness());
  });

  // ---------------------------------------------------------------------------
  // list_mailboxes
  // ---------------------------------------------------------------------------

  describe('list_mailboxes', () => {
    it('returns empty array when no manifests exist', async () => {
      const result = await service.list_mailboxes('t');
      expect(result).toEqual([]);
    });

    it('groups manifests by mailbox and picks latest for stats', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          owner_id: 'alice@test.com',
          snapshot_id: 's1',
          created_at: new Date('2026-03-01'),
          total_objects: 10,
          total_size_bytes: 1000,
        }),
        make_manifest({
          owner_id: 'alice@test.com',
          snapshot_id: 's2',
          created_at: new Date('2026-03-05'),
          total_objects: 20,
          total_size_bytes: 2000,
        }),
        make_manifest({
          owner_id: 'bob@test.com',
          snapshot_id: 's3',
          created_at: new Date('2026-03-03'),
          total_objects: 5,
          total_size_bytes: 500,
        }),
      ]);

      const result = await service.list_mailboxes('t');

      expect(result).toHaveLength(2);

      const alice = result.find((m) => m.owner_id === 'alice@test.com')!;
      expect(alice.snapshot_count).toBe(2);
      expect(alice.total_objects).toBe(20);
      expect(alice.total_size_bytes).toBe(3000);

      const bob = result.find((m) => m.owner_id === 'bob@test.com')!;
      expect(bob.snapshot_count).toBe(1);
      expect(bob.total_objects).toBe(5);
    });

    it('reports mailbox_purpose from the latest manifest after conversion', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          owner_id: 'converted@test.com',
          snapshot_id: 's1',
          created_at: new Date('2026-03-01'),
          mailbox_purpose: 'user',
        }),
        make_manifest({
          owner_id: 'converted@test.com',
          snapshot_id: 's2',
          created_at: new Date('2026-03-05'),
          mailbox_purpose: 'shared',
        }),
        make_manifest({ owner_id: 'legacy@test.com', snapshot_id: 's3' }),
      ]);

      const result = await service.list_mailboxes('t');

      const converted = result.find((m) => m.owner_id === 'converted@test.com')!;
      expect(converted.mailbox_purpose).toBe('shared');

      const legacy = result.find((m) => m.owner_id === 'legacy@test.com')!;
      expect('mailbox_purpose' in legacy).toBe(false);
    });

    it('falls back to the newest manifest that recorded a purpose when the latest lacks one', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          owner_id: 'team@test.com',
          snapshot_id: 's1',
          created_at: new Date('2026-03-01'),
          mailbox_purpose: 'shared',
        }),
        // Latest backup's purpose lookup failed -- field absent.
        make_manifest({
          owner_id: 'team@test.com',
          snapshot_id: 's2',
          created_at: new Date('2026-03-05'),
        }),
      ]);

      const result = await service.list_mailboxes('t');

      expect(result[0]!.mailbox_purpose).toBe('shared');
    });

    it('returns summaries sorted alphabetically by owner_id', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({ owner_id: 'zara@test.com', snapshot_id: 's1' }),
        make_manifest({ owner_id: 'alice@test.com', snapshot_id: 's2' }),
      ]);

      const result = await service.list_mailboxes('t');
      expect(result[0]!.owner_id).toBe('alice@test.com');
      expect(result[1]!.owner_id).toBe('zara@test.com');
    });
  });

  // ---------------------------------------------------------------------------
  // list_snapshots
  // ---------------------------------------------------------------------------

  describe('list_snapshots', () => {
    it('returns only snapshots for the specified mailbox', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({ owner_id: 'alice@test.com', snapshot_id: 's1' }),
        make_manifest({ owner_id: 'bob@test.com', snapshot_id: 's2' }),
        make_manifest({ owner_id: 'alice@test.com', snapshot_id: 's3' }),
      ]);

      const result = await service.list_snapshots('t', 'alice@test.com');

      expect(result).toHaveLength(2);
      expect(result.every((m) => m.owner_id === 'alice@test.com')).toBe(true);
    });

    it('sorts snapshots newest-first', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          owner_id: 'a@t.com',
          snapshot_id: 'old',
          created_at: new Date('2026-01-01'),
        }),
        make_manifest({
          owner_id: 'a@t.com',
          snapshot_id: 'new',
          created_at: new Date('2026-03-01'),
        }),
      ]);

      const result = await service.list_snapshots('t', 'a@t.com');

      expect(result[0]!.snapshot_id).toBe('new');
      expect(result[1]!.snapshot_id).toBe('old');
    });

    it('returns empty array when mailbox has no snapshots', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({ owner_id: 'other@test.com' }),
      ]);

      const result = await service.list_snapshots('t', 'missing@test.com');
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // get_snapshot_detail
  // ---------------------------------------------------------------------------

  describe('get_snapshot_detail', () => {
    it('delegates to find_by_snapshot', async () => {
      const manifest = make_manifest({ snapshot_id: 'snap-42' });
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.get_snapshot_detail('t', 'snap-42');

      expect(result).toBe(manifest);
      expect(mock_manifests.find_by_snapshot).toHaveBeenCalledWith(mock_context, 'snap-42');
    });

    it('returns undefined for unknown snapshot', async () => {
      const result = await service.get_snapshot_detail('t', 'nonexistent');
      expect(result).toBeUndefined();
    });
  });
});
