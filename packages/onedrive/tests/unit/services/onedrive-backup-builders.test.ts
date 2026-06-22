import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OneDriveDeltaItem } from '@wisecom/atlas-types';
import type { VersionSyncResult } from '@/services/onedrive-version-sync';
import {
  build_deleted_entry,
  build_stored_entry,
  build_snapshot_manifest,
  build_empty_result,
  accumulate_version_stats,
} from '@/services/onedrive-backup-builders';

function make_item(overrides: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    file_name: 'report.docx',
    parent_path: '/Documents',
    size_bytes: 2048,
    kind: 'file',
    deleted: false,
    ...overrides,
  };
}

describe('build_deleted_entry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-15T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a manifest entry for a deleted item', () => {
    const item = make_item({ deleted: true });
    const entry = build_deleted_entry(item, 'deleted');

    expect(entry.file_id).toBe('item-1');
    expect(entry.drive_id).toBe('drive-1');
    expect(entry.change_type).toBe('deleted');
    expect(entry.backup_at).toBe('2025-03-15T10:00:00.000Z');
    expect(entry.storage_key).toBeUndefined();
    expect(entry.checksum).toBeUndefined();
  });

  it('includes optional fields only when present on the item', () => {
    const item_with_url = make_item({ web_url: 'https://example.com/file' });
    const entry = build_deleted_entry(item_with_url, 'deleted');
    expect(entry.web_url).toBe('https://example.com/file');

    const item_without_url = make_item();
    const entry2 = build_deleted_entry(item_without_url, 'deleted');
    expect(entry2).not.toHaveProperty('web_url');
  });

  it('includes last_modified_at and etag when present', () => {
    const item = make_item({ last_modified_at: '2025-01-01T00:00:00Z', etag: '"abc123"' });
    const entry = build_deleted_entry(item, 'deleted');
    expect(entry.last_modified_at).toBe('2025-01-01T00:00:00Z');
    expect(entry.etag).toBe('"abc123"');
  });
});

describe('build_stored_entry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-03-15T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a manifest entry with storage_key and checksum', () => {
    const item = make_item();
    const entry = build_stored_entry(item, 'od/owner-1/sha256abc', 'sha256abc', 'created');

    expect(entry.file_id).toBe('item-1');
    expect(entry.storage_key).toBe('od/owner-1/sha256abc');
    expect(entry.checksum).toBe('sha256abc');
    expect(entry.change_type).toBe('created');
    expect(entry.backup_at).toBe('2025-03-15T10:00:00.000Z');
  });

  it('omits optional fields not present on item', () => {
    const item = make_item();
    const entry = build_stored_entry(item, 'key', 'hash', 'updated');
    expect(entry).not.toHaveProperty('web_url');
    expect(entry).not.toHaveProperty('etag');
  });
});

describe('build_snapshot_manifest', () => {
  it('creates a valid manifest with entries', () => {
    const entries = [
      {
        file_id: 'f1',
        drive_id: 'd1',
        file_name: 'a.txt',
        parent_path: '/',
        size_bytes: 100,
        backup_at: '2025-01-01',
        change_type: 'created' as const,
      },
      {
        file_id: 'f2',
        drive_id: 'd1',
        file_name: 'b.txt',
        parent_path: '/',
        size_bytes: 200,
        backup_at: '2025-01-01',
        change_type: 'updated' as const,
      },
    ];
    const manifest = build_snapshot_manifest(
      't1',
      'owner-1',
      entries,
      'snap-001',
      new Date('2025-03-01'),
    );

    expect(manifest.id).toBe('owner-1-snap-001');
    expect(manifest.tenant_id).toBe('t1');
    expect(manifest.owner_id).toBe('owner-1');
    expect(manifest.snapshot_id).toBe('snap-001');
    expect(manifest.total_files).toBe(2);
    expect(manifest.total_size_bytes).toBe(300);
    expect(manifest.entries).toHaveLength(2);
  });

  it('includes owner identity when provided', () => {
    const manifest = build_snapshot_manifest(
      't1',
      'owner-1',
      [],
      'snap-001',
      new Date(),
      'user@company.com',
      'John Doe',
    );
    expect(manifest.owner_email).toBe('user@company.com');
    expect(manifest.owner_display_name).toBe('John Doe');
  });

  it('omits owner identity when not provided', () => {
    const manifest = build_snapshot_manifest('t1', 'owner-1', [], 'snap-001', new Date());
    expect(manifest).not.toHaveProperty('owner_email');
    expect(manifest).not.toHaveProperty('owner_display_name');
  });

  it('computes total_size_bytes from all entries', () => {
    const entries = [
      {
        file_id: 'f1',
        drive_id: 'd1',
        file_name: 'a.txt',
        parent_path: '/',
        size_bytes: 1000,
        backup_at: '2025-01-01',
        change_type: 'created' as const,
      },
      {
        file_id: 'f2',
        drive_id: 'd1',
        file_name: 'b.txt',
        parent_path: '/',
        size_bytes: 2500,
        backup_at: '2025-01-01',
        change_type: 'created' as const,
      },
      {
        file_id: 'f3',
        drive_id: 'd1',
        file_name: 'c.txt',
        parent_path: '/',
        size_bytes: 500,
        backup_at: '2025-01-01',
        change_type: 'deleted' as const,
      },
    ];
    const manifest = build_snapshot_manifest('t1', 'owner-1', entries, 'snap-002', new Date());
    expect(manifest.total_size_bytes).toBe(4000);
  });
});

describe('build_empty_result', () => {
  it('produces a result with snapshot undefined and given counters', () => {
    const result = build_empty_result('owner-1', 2, 5, 3, 1, 4, 2, [], [], true);

    expect(result.owner_id).toBe('owner-1');
    expect(result.snapshot).toBeUndefined();
    expect(result.summary.drives_scanned).toBe(2);
    expect(result.summary.files_stored).toBe(5);
    expect(result.summary.files_deduplicated).toBe(3);
    expect(result.summary.deleted_items).toBe(1);
    expect(result.summary.versions_stored).toBe(4);
    expect(result.summary.versions_unavailable).toBe(2);
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.healthy).toBe(true);
    expect(result.summary.files_changed).toBe(0);
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.cursor_updated).toBe(true);
  });

  it('marks unhealthy when errors are present', () => {
    const result = build_empty_result(
      'owner-1',
      1,
      0,
      0,
      0,
      0,
      0,
      ['timeout on file X'],
      [],
      false,
    );

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors).toEqual(['timeout on file X']);
  });
});

describe('accumulate_version_stats', () => {
  it('accumulates stats from a version sync result', () => {
    const sync_result: VersionSyncResult = {
      new_versions_stored: 3,
      versions_deduplicated: 1,
      versions_unavailable: 2,
      versions_failed: 1,
    };
    const current = {
      total_versions_stored: 5,
      total_versions_unavailable: 1,
      total_versions_failed: 0,
    };
    const set = vi.fn();

    accumulate_version_stats(sync_result, current, set);

    expect(set).toHaveBeenCalledWith(8, 3, 1);
  });

  it('works from zero', () => {
    const sync_result: VersionSyncResult = {
      new_versions_stored: 1,
      versions_deduplicated: 0,
      versions_unavailable: 0,
      versions_failed: 0,
    };
    const current = {
      total_versions_stored: 0,
      total_versions_unavailable: 0,
      total_versions_failed: 0,
    };
    const set = vi.fn();

    accumulate_version_stats(sync_result, current, set);

    expect(set).toHaveBeenCalledWith(1, 0, 0);
  });
});
