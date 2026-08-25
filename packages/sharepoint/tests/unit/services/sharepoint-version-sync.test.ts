import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SharePointSiteConnector,
  SharePointDeltaItem,
  TenantContext,
} from '@wisecom/atlas-types';
import { sync_file_versions } from '@/services/sharepoint-version-sync';

function make_item(overrides: Partial<SharePointDeltaItem> = {}): SharePointDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    file_name: 'report.docx',
    parent_path: '/Shared Documents',
    size_bytes: 1024,
    kind: 'file',
    deleted: false,
    ...overrides,
  };
}

function make_connector(overrides: Partial<SharePointSiteConnector> = {}): SharePointSiteConnector {
  return {
    list_sites: vi.fn(),
    resolve_site: vi.fn(),
    list_document_libraries: vi.fn(),
    fetch_delta: vi.fn(),
    download_file_content: vi.fn(),
    resolve_download_url: vi.fn(),
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
  const site_id = 'site-1';
  const snapshot_id = 'snap-1';

  beforeEach(() => {
    ctx = make_ctx();
  });

  it('returns empty result when no versions exist', async () => {
    connector = make_connector({ list_file_versions: vi.fn().mockResolvedValue([]) });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, new Set());

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
      { version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 },
      { version_id: 'v3', last_modified_at: '2025-01-02', size_bytes: 600 },
    ];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, new Set());

    expect(result.new_versions_stored).toBe(2);
    expect(result.versions_deduplicated).toBe(0);
    expect(ctx.storage.put).toHaveBeenCalledTimes(2);
    // Rows are returned for the run's single index object instead of written per file (issue #161).
    expect(result.records.map((record) => record.version_id)).toEqual(['v2', 'v3']);
    expect(result.records[0]).toMatchObject({
      snapshot_id,
      drive_id: item.drive_id,
      file_name: item.file_name,
      parent_path: item.parent_path,
      change_type: 'updated',
    });
  });

  it('skips already-known version IDs', async () => {
    const versions = [{ version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 }];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
    });

    const result = await sync_file_versions(
      connector,
      item,
      site_id,
      snapshot_id,
      ctx,
      new Set(['v2']),
    );

    expect(result.new_versions_stored).toBe(0);
    expect(connector.download_file_version).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
  });

  it('deduplicates when storage key already exists', async () => {
    connector = make_connector({
      list_file_versions: vi
        .fn()
        .mockResolvedValue([{ version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 }]),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });
    (ctx.storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, new Set());

    expect(result.versions_deduplicated).toBe(1);
    expect(result.new_versions_stored).toBe(0);
    expect(ctx.storage.put).not.toHaveBeenCalled();
    // The row is still recorded so the version stays addressable in history.
    expect(result.records.length).toBe(1);
  });

  it('counts unavailable versions (404/410)', async () => {
    connector = make_connector({
      list_file_versions: vi
        .fn()
        .mockResolvedValue([{ version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 }]),
      download_file_version: vi.fn().mockRejectedValue({ statusCode: 404 }),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, new Set());

    expect(result.versions_unavailable).toBe(1);
    expect(result.versions_failed).toBe(0);
    expect(result.records).toEqual([]);
  });

  it('counts failed versions on unexpected errors', async () => {
    connector = make_connector({
      list_file_versions: vi
        .fn()
        .mockResolvedValue([{ version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 }]),
      download_file_version: vi.fn().mockRejectedValue(new Error('server error')),
    });

    const result = await sync_file_versions(connector, item, site_id, snapshot_id, ctx, new Set());

    expect(result.versions_failed).toBe(1);
    expect(result.versions_unavailable).toBe(0);
  });
});
