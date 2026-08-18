import { describe, it, expect } from 'vitest';
import {
  aggregate_drive_stats,
  type DriveManifestSummary,
} from '@/services/stats/drive-stats-aggregator';

function summary(overrides: Partial<DriveManifestSummary> = {}): DriveManifestSummary {
  return {
    owner_id: 'owner-1',
    created_at: new Date('2026-01-15T00:00:00Z'),
    total_files: 2,
    total_size_bytes: 100,
    ...overrides,
  };
}

describe('aggregate_drive_stats', () => {
  it('returns zeroed stats for no manifests', () => {
    const result = aggregate_drive_stats('t', 'onedrive', []);

    expect(result).toEqual({
      tenant_id: 't',
      service: 'onedrive',
      owner_count: 0,
      snapshot_count: 0,
      file_count: 0,
      total_size_bytes: 0,
      owners: [],
      monthly_breakdown: [],
    });
  });

  it('groups by owner and sorts owners by size descending', () => {
    const result = aggregate_drive_stats('t', 'onedrive', [
      summary({ owner_id: 'small', total_size_bytes: 10 }),
      summary({ owner_id: 'big', total_size_bytes: 900 }),
      summary({ owner_id: 'small', total_size_bytes: 20 }),
    ]);

    expect(result.owner_count).toBe(2);
    expect(result.snapshot_count).toBe(3);
    expect(result.owners.map((o) => o.owner_id)).toEqual(['big', 'small']);
    expect(result.owners[1]?.snapshot_count).toBe(2);
    expect(result.owners[1]?.total_size_bytes).toBe(30);
  });

  it('tracks the latest backup timestamp per owner', () => {
    const result = aggregate_drive_stats('t', 'sharepoint', [
      summary({ created_at: new Date('2026-02-01T00:00:00Z') }),
      summary({ created_at: new Date('2026-01-01T00:00:00Z') }),
    ]);

    expect(result.owners[0]?.latest_backup_at).toBe('2026-02-01T00:00:00.000Z');
  });

  it('builds a chronologically sorted monthly breakdown', () => {
    const result = aggregate_drive_stats('t', 'onedrive', [
      summary({ created_at: new Date('2026-03-01T00:00:00Z'), total_files: 1 }),
      summary({ created_at: new Date('2026-01-01T00:00:00Z'), total_files: 4 }),
      summary({ created_at: new Date('2026-03-20T00:00:00Z'), total_files: 2 }),
    ]);

    expect(result.monthly_breakdown).toEqual([
      { month: '2026-01', snapshot_count: 1, file_count: 4, total_size_bytes: 100 },
      { month: '2026-03', snapshot_count: 2, file_count: 3, total_size_bytes: 200 },
    ]);
  });

  it('omits owner_label when no manifest carries one', () => {
    const result = aggregate_drive_stats('t', 'onedrive', [summary()]);

    expect(result.owners[0]).not.toHaveProperty('owner_label');
  });
});
