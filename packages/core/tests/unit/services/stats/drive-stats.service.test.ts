import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { StatsService } from '@/services/stats/stats.service';
import type {
  ManifestRepository,
  OneDriveManifestRepository,
  OneDriveSnapshotSummary,
  SharePointManifestRepository,
  SharePointSnapshotSummary,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { readable_summaries } from '@wisecom/atlas-types/testing/readable-listing';

/** OneDrive and SharePoint statistics, which read the owners' snapshot summary indexes (#625). */
describe('StatsService drive statistics', () => {
  let mock_od_manifests: OneDriveManifestRepository;
  let mock_sp_manifests: SharePointManifestRepository;
  let service: StatsService;

  beforeEach(() => {
    const ctx = { destroy: vi.fn() } as unknown as TenantContext;
    const factory = {
      create_readonly: vi.fn().mockResolvedValue(ctx),
    } as unknown as TenantContextFactory;
    mock_od_manifests = {
      list_snapshot_summaries: vi.fn().mockResolvedValue(readable_summaries()),
      list_all_snapshot_summaries: vi.fn().mockResolvedValue(readable_summaries()),
    } as unknown as OneDriveManifestRepository;
    mock_sp_manifests = {
      list_snapshot_summaries: vi.fn().mockResolvedValue(readable_summaries()),
      list_all_snapshot_summaries: vi.fn().mockResolvedValue(readable_summaries()),
    } as unknown as SharePointManifestRepository;
    service = new StatsService(
      factory,
      {} as ManifestRepository,
      mock_od_manifests,
      mock_sp_manifests,
    );
  });

  describe('get_onedrive_stats', () => {
    const od_summary = (overrides: Partial<OneDriveSnapshotSummary>): OneDriveSnapshotSummary => ({
      owner_id: 'owner-1',
      snapshot_id: 's1',
      manifest_key: 'onedrive/manifests/owner-1/s1.json',
      created_at: new Date('2026-03-05T00:00:00Z'),
      entry_count: 0,
      total_files: 3,
      total_size_bytes: 100,
      ...overrides,
    });

    it('aggregates all owners from their summary indexes when no owner is given', async () => {
      vi.mocked(mock_od_manifests.list_all_snapshot_summaries).mockResolvedValue(
        readable_summaries([
          od_summary({ owner_id: 'a', owner_email: 'a@test.com' }),
          od_summary({ owner_id: 'b', snapshot_id: 's2', total_size_bytes: 400 }),
        ]),
      );

      const result = await service.get_onedrive_stats('t');

      expect(result.service).toBe('onedrive');
      expect(result.owner_count).toBe(2);
      expect(result.snapshot_count).toBe(2);
      expect(result.file_count).toBe(6);
      expect(result.total_size_bytes).toBe(500);
      expect(result.owners[0]?.owner_id).toBe('b');
      expect(result.owners[1]?.owner_label).toBe('a@test.com');
      expect(result.monthly_breakdown).toEqual([
        { month: '2026-03', snapshot_count: 2, file_count: 6, total_size_bytes: 500 },
      ]);
      expect(mock_od_manifests.list_snapshot_summaries).not.toHaveBeenCalled();
    });

    it('scopes to a single owner when given', async () => {
      vi.mocked(mock_od_manifests.list_snapshot_summaries).mockResolvedValue(
        readable_summaries([od_summary({ owner_id: 'a' })]),
      );

      const result = await service.get_onedrive_stats('t', 'a');

      expect(result.owner_count).toBe(1);
      expect(result.snapshot_count).toBe(1);
      expect(mock_od_manifests.list_all_snapshot_summaries).not.toHaveBeenCalled();
    });

    it('refuses totals that would leave out a manifest it could not read', async () => {
      const damaged = 'onedrive/manifests/a/od-snap-1-x.json';
      vi.mocked(mock_od_manifests.list_snapshot_summaries).mockResolvedValue({
        summaries: [od_summary({ owner_id: 'a' })],
        unreadable_keys: [damaged],
      });

      await expect(service.get_onedrive_stats('t', 'a')).rejects.toMatchObject({
        unreadable_keys: [damaged],
      });
    });
  });

  describe('get_sharepoint_stats', () => {
    const sp_summary = (
      overrides: Partial<SharePointSnapshotSummary>,
    ): SharePointSnapshotSummary => ({
      site_id: 'site-1',
      snapshot_id: 's1',
      manifest_key: 'sharepoint/manifests/site-1/s1.json',
      created_at: new Date('2026-04-10T00:00:00Z'),
      entry_count: 0,
      total_files: 5,
      total_size_bytes: 250,
      ...overrides,
    });

    it('aggregates all sites and labels them by display name', async () => {
      vi.mocked(mock_sp_manifests.list_all_snapshot_summaries).mockResolvedValue(
        readable_summaries([
          sp_summary({ site_display_name: 'Intranet' }),
          sp_summary({ snapshot_id: 's2' }),
        ]),
      );

      const result = await service.get_sharepoint_stats('t');

      expect(result.service).toBe('sharepoint');
      expect(result.owner_count).toBe(1);
      expect(result.snapshot_count).toBe(2);
      expect(result.file_count).toBe(10);
      expect(result.total_size_bytes).toBe(500);
      expect(result.owners[0]?.owner_label).toBe('Intranet');
      expect(result.owners[0]?.latest_backup_at).toBe('2026-04-10T00:00:00.000Z');
    });

    it('scopes to a single site when given', async () => {
      vi.mocked(mock_sp_manifests.list_snapshot_summaries).mockResolvedValue(
        readable_summaries([sp_summary({})]),
      );

      const result = await service.get_sharepoint_stats('t', 'site-1');

      expect(result.snapshot_count).toBe(1);
      expect(mock_sp_manifests.list_all_snapshot_summaries).not.toHaveBeenCalled();
    });
  });
});
