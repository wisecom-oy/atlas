import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SharePointSiteConnector,
  SharePointDeltaItem,
  TenantContext,
} from '@wisecom/atlas-types';
import { sync_file_versions } from '@/services/versioning/version-sync';

function make_item(overrides: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    file_name: 'file.txt',
    parent_path: '/docs',
    size_bytes: 1234,
    etag: 'e1',
    deleted: false,
    kind: 'file',
    ...overrides,
  } as SharePointDeltaItem;
}

function make_connector(overrides: Partial<SharePointSiteConnector> = {}): SharePointSiteConnector {
  return {
    list_file_versions: vi.fn().mockResolvedValue([]),
    download_file_version: vi.fn(),
    ...overrides,
  } as unknown as SharePointSiteConnector;
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 'tenant-1',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      begin_multipart_upload: vi.fn(),
      copy: vi.fn(),
      abort_incomplete_uploads: vi.fn(),
    },
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
    create_cipher: vi.fn(),
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

describe('sync_file_versions', () => {
  let connector: SharePointSiteConnector;
  let ctx: TenantContext;
  const item = make_item();
  const site_id = 'site-abc';
  const snapshot_id = 'snap-001';

  beforeEach(() => {
    ctx = make_ctx();
  });

  it('returns empty result when no versions exist', async () => {
    connector = make_connector({ list_file_versions: vi.fn().mockResolvedValue([]) });
    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);
    expect(result).toEqual({
      new_versions_stored: 0,
      versions_deduplicated: 0,
      versions_unavailable: 0,
      versions_failed: 0,
      records: [],
    });
  });

  it('stores new versions and returns correct counts', async () => {
    const versions = [
      { version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 },
      { version_id: 'v3.0', last_modified_at: '2024-02-01', size_bytes: 600 },
    ];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);

    expect(result.new_versions_stored).toBe(2);
    expect(result.versions_deduplicated).toBe(0);
    expect(result.versions_unavailable).toBe(0);
    expect(result.versions_failed).toBe(0);
    expect(ctx.storage.put).toHaveBeenCalledTimes(2);
    // Rows are returned for the run's single index object instead of written per file (issue #161).
    expect(result.records.map((r) => r.version_id)).toEqual(['v2.0', 'v3.0']);
    expect(result.records[0]).toMatchObject({
      snapshot_id,
      drive_id: item.drive_id,
      file_name: item.file_name,
      change_type: 'updated',
    });
  });

  it('skips versions at or below the watermark without contacting Graph', async () => {
    const versions = [
      { version_id: 'v2.0', last_modified_at: '2024-01-01T00:00:00Z', size_bytes: 500 },
      { version_id: 'v3.0', last_modified_at: '2024-02-01T00:00:00Z', size_bytes: 600 },
    ];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, {
      last_modified_at: '2024-01-01T00:00:00Z',
      version_ids: ['v2.0'],
    });

    expect(connector.download_file_version).toHaveBeenCalledTimes(1);
    expect(result.records.map((r) => r.version_id)).toEqual(['v3.0']);
    expect(result.next_watermark).toEqual({
      last_modified_at: '2024-02-01T00:00:00Z',
      version_ids: ['v3.0'],
    });
  });

  it('captures only unseen version ids at the watermark timestamp', async () => {
    const versions = [
      { version_id: 'v2.0', last_modified_at: '2024-01-01T00:00:00Z', size_bytes: 500 },
      { version_id: 'v3.0', last_modified_at: '2024-01-01T00:00:00Z', size_bytes: 600 },
    ];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, {
      last_modified_at: '2024-01-01T00:00:00Z',
      version_ids: ['v2.0'],
    });

    expect(connector.download_file_version).toHaveBeenCalledTimes(1);
    expect(connector.download_file_version).toHaveBeenCalledWith(
      item.drive_id,
      item.item_id,
      'v3.0',
    );
    expect(result.next_watermark).toEqual({
      last_modified_at: '2024-01-01T00:00:00Z',
      version_ids: ['v2.0', 'v3.0'],
    });
  });

  it('upgrades a legacy timestamp without skipping equal-second versions', async () => {
    const versions = [
      { version_id: 'v2.0', last_modified_at: '2024-01-01T00:00:00Z', size_bytes: 500 },
      { version_id: 'v3.0', last_modified_at: '2024-01-01T00:00:00Z', size_bytes: 600 },
    ];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });

    const result = await sync_file_versions(
      connector,
      item,
      site_id,
      snapshot_id,
      ctx,
      '2024-01-01T00:00:00Z',
    );

    expect(connector.download_file_version).toHaveBeenCalledTimes(2);
    expect(result.next_watermark).toEqual({
      last_modified_at: '2024-01-01T00:00:00Z',
      version_ids: ['v2.0', 'v3.0'],
    });
  });

  it('deduplicates when storage key already exists', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('duplicate')),
    });
    (ctx.storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);

    expect(result.versions_deduplicated).toBe(1);
    expect(result.new_versions_stored).toBe(0);
    expect(ctx.storage.put).not.toHaveBeenCalled();
    // The row is still recorded so the version stays addressable in history.
    expect(result.records.length).toBe(1);
  });

  it('classifies 404 errors as unavailable (not failed)', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    const error_404 = Object.assign(new Error('Not Found'), { statusCode: 404 });
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockRejectedValue(error_404),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);

    expect(result.versions_unavailable).toBe(1);
    expect(result.versions_failed).toBe(0);
    expect(result.records).toEqual([]);
  });

  it('classifies 410 errors as unavailable', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    const error_410 = Object.assign(new Error('Gone'), { status: 410 });
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockRejectedValue(error_410),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);

    expect(result.versions_unavailable).toBe(1);
    expect(result.versions_failed).toBe(0);
  });

  it('classifies 403 errors as failed', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    const error_403 = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockRejectedValue(error_403),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);

    expect(result.versions_failed).toBe(1);
    expect(result.versions_unavailable).toBe(0);
  });

  it('classifies 500 errors as failed', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockRejectedValue(new Error('Internal Server Error')),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);

    expect(result.versions_failed).toBe(1);
    expect(result.versions_unavailable).toBe(0);
  });

  it('handles mixed outcomes correctly', async () => {
    const versions = [
      { version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 100 },
      { version_id: 'v3.0', last_modified_at: '2024-02-01', size_bytes: 200 },
      { version_id: 'v4.0', last_modified_at: '2024-03-01', size_bytes: 300 },
    ];
    const error_404 = Object.assign(new Error('Not Found'), { statusCode: 404 });
    const error_500 = Object.assign(new Error('Server Error'), { statusCode: 500 });

    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from('v2-content'))
        .mockRejectedValueOnce(error_404)
        .mockRejectedValueOnce(error_500),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);

    expect(result.new_versions_stored).toBe(1);
    expect(result.versions_unavailable).toBe(1);
    expect(result.versions_failed).toBe(1);
    expect(result.records.length).toBe(1);
    // v2 captured, v3 permanently gone, v4 failed: the mark stops at v3 so the
    // next run retries v4 rather than skipping past it.
    expect(result.next_watermark).toEqual({
      last_modified_at: '2024-02-01',
      version_ids: ['v3.0'],
    });
  });

  it('walks versions oldest first even though Graph returns them newest first', async () => {
    const versions = [
      { version_id: 'v4.0', last_modified_at: '2024-03-01T00:00:00Z', size_bytes: 300 },
      { version_id: 'v3.0', last_modified_at: '2024-02-01T00:00:00Z', size_bytes: 200 },
      { version_id: 'v2.0', last_modified_at: '2024-01-01T00:00:00Z', size_bytes: 100 },
    ];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);

    expect(result.records.map((r) => r.version_id)).toEqual(['v2.0', 'v3.0', 'v4.0']);
    expect(result.next_watermark).toEqual({
      last_modified_at: '2024-03-01T00:00:00Z',
      version_ids: ['v4.0'],
    });
  });

  it('holds the watermark back when the oldest version fails unexpectedly', async () => {
    const versions = [
      { version_id: 'v2.0', last_modified_at: '2024-01-01T00:00:00Z', size_bytes: 100 },
      { version_id: 'v3.0', last_modified_at: '2024-02-01T00:00:00Z', size_bytes: 200 },
    ];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Server Error'), { statusCode: 500 }))
        .mockResolvedValueOnce(Buffer.from('v3-content')),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, undefined);

    // v3 is captured, but the mark must not jump the failed v2 or its retry is lost.
    expect(result.records.map((r) => r.version_id)).toEqual(['v3.0']);
    expect(result.next_watermark).toBeUndefined();
  });

  it('never treats a version without a usable timestamp as already captured', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '', size_bytes: 100 }];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });

    const result = await sync_file_versions(
      connector,
      item,
      site_id,
      snapshot_id,
      ctx,
      '2030-01-01T00:00:00Z',
    );

    expect(connector.download_file_version).toHaveBeenCalledTimes(1);
    expect(result.next_watermark).toBeUndefined();
  });
});
