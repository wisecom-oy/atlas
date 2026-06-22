import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  OneDriveConnector,
  OneDriveDeltaItem,
  OneDriveFileVersionIndexRepository,
  TenantContext,
} from '@atlas/types';
import { sync_file_versions } from '@/services/onedrive-version-sync';

function make_item(overrides: Partial<OneDriveDeltaItem> = {}): OneDriveDeltaItem {
  return {
    item_id: 'item-1',
    drive_id: 'drive-1',
    file_name: 'report.docx',
    parent_path: '/Documents',
    size_bytes: 1024,
    kind: 'file',
    deleted: false,
    ...overrides,
  };
}

function make_connector(overrides: Partial<OneDriveConnector> = {}): OneDriveConnector {
  return {
    list_drives: vi.fn(),
    fetch_delta: vi.fn(),
    download_file_content: vi.fn(),
    resolve_download_url: vi.fn(),
    list_file_versions: vi.fn().mockResolvedValue([]),
    download_file_version: vi.fn(),
    ...overrides,
  } as unknown as OneDriveConnector;
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

function make_file_indexes(): OneDriveFileVersionIndexRepository {
  return {
    find_by_file_id: vi.fn().mockResolvedValue(undefined),
    append_version: vi.fn().mockResolvedValue(undefined),
  } as unknown as OneDriveFileVersionIndexRepository;
}

describe('sync_file_versions', () => {
  let connector: OneDriveConnector;
  let ctx: TenantContext;
  let file_indexes: OneDriveFileVersionIndexRepository;
  const item = make_item();
  const owner_id = 'owner-abc';
  const snapshot_id = 'snap-001';

  beforeEach(() => {
    ctx = make_ctx();
    file_indexes = make_file_indexes();
  });

  it('returns empty result when no versions exist', async () => {
    connector = make_connector({ list_file_versions: vi.fn().mockResolvedValue([]) });
    const result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );
    expect(result).toEqual({
      new_versions_stored: 0,
      versions_deduplicated: 0,
      versions_unavailable: 0,
      versions_failed: 0,
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

    const result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );

    expect(result.new_versions_stored).toBe(2);
    expect(result.versions_deduplicated).toBe(0);
    expect(result.versions_unavailable).toBe(0);
    expect(result.versions_failed).toBe(0);
    expect(ctx.storage.put).toHaveBeenCalledTimes(2);
    expect(file_indexes.append_version).toHaveBeenCalledTimes(2);
  });

  it('skips already-known versions (deduplication by version_id)', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('content')),
    });
    (file_indexes.find_by_file_id as ReturnType<typeof vi.fn>).mockResolvedValue({
      file_id: 'item-1',
      owner_id,
      versions: [{ version_id: 'v2.0' }],
    });

    const result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );

    expect(result.new_versions_stored).toBe(0);
    expect(connector.download_file_version).not.toHaveBeenCalled();
  });

  it('deduplicates when storage key already exists', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockResolvedValue(Buffer.from('duplicate')),
    });
    (ctx.storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );

    expect(result.versions_deduplicated).toBe(1);
    expect(result.new_versions_stored).toBe(0);
    expect(ctx.storage.put).not.toHaveBeenCalled();
  });

  it('classifies 404 errors as unavailable (not failed)', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    const error_404 = Object.assign(new Error('Not Found'), { statusCode: 404 });
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockRejectedValue(error_404),
    });

    const result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );

    expect(result.versions_unavailable).toBe(1);
    expect(result.versions_failed).toBe(0);
  });

  it('classifies 410 errors as unavailable', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    const error_410 = Object.assign(new Error('Gone'), { status: 410 });
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockRejectedValue(error_410),
    });

    const result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );

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

    const result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );

    expect(result.versions_failed).toBe(1);
    expect(result.versions_unavailable).toBe(0);
  });

  it('classifies 500 errors as failed', async () => {
    const versions = [{ version_id: 'v2.0', last_modified_at: '2024-01-01', size_bytes: 500 }];
    connector = make_connector({
      list_file_versions: vi.fn().mockResolvedValue(versions),
      download_file_version: vi.fn().mockRejectedValue(new Error('Internal Server Error')),
    });

    const result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );

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

    const result = await sync_file_versions(
      connector,
      item,
      owner_id,
      snapshot_id,
      ctx,
      file_indexes,
    );

    expect(result.new_versions_stored).toBe(1);
    expect(result.versions_unavailable).toBe(1);
    expect(result.versions_failed).toBe(1);
  });
});
