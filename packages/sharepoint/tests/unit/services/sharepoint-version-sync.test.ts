import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SharePointSiteConnector,
  SharePointDeltaItem,
  SharePointFileVersionIndexRepository,
  TenantContext,
} from '@atlas/types';
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

function make_file_indexes(): SharePointFileVersionIndexRepository {
  return {
    find_by_file_id: vi.fn().mockResolvedValue(undefined),
    append_version: vi.fn().mockResolvedValue(undefined),
  } as unknown as SharePointFileVersionIndexRepository;
}

describe('sync_file_versions', () => {
  let connector: SharePointSiteConnector;
  let ctx: TenantContext;
  let file_indexes: SharePointFileVersionIndexRepository;

  beforeEach(() => {
    connector = make_connector();
    ctx = make_ctx();
    file_indexes = make_file_indexes();
  });

  it('returns empty result when no versions exist', async () => {
    const result = await sync_file_versions(
      connector,
      make_item(),
      'site-1',
      'snap-1',
      ctx,
      file_indexes,
    );

    expect(result.new_versions_stored).toBe(0);
    expect(result.versions_deduplicated).toBe(0);
    expect(result.versions_unavailable).toBe(0);
    expect(result.versions_failed).toBe(0);
  });

  it('downloads and stores new versions', async () => {
    const versions = [
      { version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 },
      { version_id: 'v3', last_modified_at: '2025-01-02', size_bytes: 600 },
    ];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });

    const result = await sync_file_versions(
      connector,
      make_item(),
      'site-1',
      'snap-1',
      ctx,
      file_indexes,
    );

    expect(result.new_versions_stored).toBe(2);
    expect(file_indexes.append_version).toHaveBeenCalledTimes(2);
  });

  it('skips already-known version IDs', async () => {
    const versions = [{ version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 }];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
    });
    file_indexes = {
      ...make_file_indexes(),
      find_by_file_id: vi.fn().mockResolvedValue({
        file_id: 'item-1',
        site_id: 'site-1',
        versions: [{ version_id: 'v2' }],
      }),
    } as unknown as SharePointFileVersionIndexRepository;

    const result = await sync_file_versions(
      connector,
      make_item(),
      'site-1',
      'snap-1',
      ctx,
      file_indexes,
    );

    expect(result.new_versions_stored).toBe(0);
    expect(connector.download_file_version).not.toHaveBeenCalled();
  });

  it('deduplicates when storage key already exists', async () => {
    connector = make_connector({
      list_file_versions: vi
        .fn()
        .mockResolvedValue([{ version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 }]),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });
    (ctx.storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const result = await sync_file_versions(
      connector,
      make_item(),
      'site-1',
      'snap-1',
      ctx,
      file_indexes,
    );

    expect(result.versions_deduplicated).toBe(1);
    expect(result.new_versions_stored).toBe(0);
    expect(ctx.storage.put).not.toHaveBeenCalled();
  });

  it('counts unavailable versions (404/410)', async () => {
    connector = make_connector({
      list_file_versions: vi
        .fn()
        .mockResolvedValue([{ version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 }]),
      download_file_version: vi.fn().mockRejectedValue({ statusCode: 404 }),
    });

    const result = await sync_file_versions(
      connector,
      make_item(),
      'site-1',
      'snap-1',
      ctx,
      file_indexes,
    );

    expect(result.versions_unavailable).toBe(1);
    expect(result.versions_failed).toBe(0);
  });

  it('counts failed versions on unexpected errors', async () => {
    connector = make_connector({
      list_file_versions: vi
        .fn()
        .mockResolvedValue([{ version_id: 'v2', last_modified_at: '2025-01-01', size_bytes: 500 }]),
      download_file_version: vi.fn().mockRejectedValue(new Error('server error')),
    });

    const result = await sync_file_versions(
      connector,
      make_item(),
      'site-1',
      'snap-1',
      ctx,
      file_indexes,
    );

    expect(result.versions_failed).toBe(1);
    expect(result.versions_unavailable).toBe(0);
  });
});
