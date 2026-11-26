import { describe, expect, it, vi } from 'vitest';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { stub_drive_version_download } from '@wisecom/atlas-types/testing/stub-drive-version-download';
import type { DriveContentConnector, DriveDeltaItem, DriveFileVersion } from '@/drive-ports';
import { build_drive_storage_keys } from '@/shared/storage-keys';
import { capture_owed_file_versions } from '@/versioning/owed-version-capture';
import {
  forget_pending_versions,
  type RunVersionCollector,
} from '@/versioning/run-version-collector';

// Issue #858: deduplicated content was read as "this change was fully processed", so a run that
// stopped between storing the content and capturing the versions lost them for good.

const KEYS = build_drive_storage_keys('test-drive');
const ITEM = {
  item_id: 'item-1',
  drive_id: 'drive-1',
  file_name: 'Report.docx',
  parent_path: '/Documents',
} as DriveDeltaItem;

const VERSIONS: DriveFileVersion[] = [
  { version_id: '2.0', last_modified_at: '2026-02-01T00:00:00Z', size_bytes: 20 },
  { version_id: '1.0', last_modified_at: '2026-01-01T00:00:00Z', size_bytes: 10 },
];

function make_connector(overrides: Partial<DriveContentConnector> = {}): DriveContentConnector {
  return {
    list_file_versions: vi.fn().mockResolvedValue(VERSIONS),
    download_file_version: vi.fn().mockImplementation(stub_drive_version_download()),
    stream_file_version: vi.fn(),
    ...overrides,
  } as unknown as DriveContentConnector;
}

function make_versions(overrides: Partial<RunVersionCollector> = {}): RunVersionCollector {
  return { watermarks: {}, pending: {}, rows: new Map(), ...overrides };
}

async function capture(
  connector: DriveContentConnector,
  versions: RunVersionCollector,
  content_deduplicated: boolean,
): Promise<unknown> {
  const { ctx } = in_memory_tenant_context();
  return await capture_owed_file_versions(
    KEYS,
    connector,
    ITEM,
    'owner-1',
    'snap-1',
    ctx,
    versions,
    content_deduplicated,
  );
}

describe('capture_owed_file_versions', () => {
  it('asks Graph nothing for deduplicated content that owes no versions', async () => {
    const connector = make_connector();

    const outcome = await capture(connector, make_versions(), true);

    expect(outcome).toBeUndefined();
    expect(connector.list_file_versions).not.toHaveBeenCalled();
  });

  it('captures the versions of newly stored content and settles the file', async () => {
    const versions = make_versions();

    await capture(make_connector(), versions, false);

    expect(versions.pending).toEqual({});
    expect(versions.rows.get(ITEM.item_id)?.map((row) => row.version_id)).toEqual(['1.0', '2.0']);
  });

  it('leaves the file pending when the version listing throws', async () => {
    const versions = make_versions();
    const connector = make_connector({
      list_file_versions: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
    });

    await expect(capture(connector, versions, false)).rejects.toThrow('503');

    expect(versions.pending).toEqual({ [ITEM.item_id]: {} });
  });

  it('captures a pending file even though its content deduplicates', async () => {
    const versions = make_versions({ pending: { [ITEM.item_id]: {} } });
    const connector = make_connector();

    await capture(connector, versions, true);

    expect(connector.download_file_version).toHaveBeenCalledTimes(2);
    expect(versions.pending).toEqual({});
  });

  it('downloads nothing again for a pending file the watermark already covers', async () => {
    const versions = make_versions({
      pending: { [ITEM.item_id]: {} },
      watermarks: {
        [ITEM.item_id]: { last_modified_at: '2026-02-01T00:00:00Z', version_ids: ['2.0'] },
      },
    });
    const connector = make_connector();

    await capture(connector, versions, true);

    expect(connector.list_file_versions).toHaveBeenCalledTimes(1);
    expect(connector.download_file_version).not.toHaveBeenCalled();
    expect(versions.pending).toEqual({});
  });

  it('keeps a file with an unconfirmed "not found" version pending, with its streak', async () => {
    const versions = make_versions();
    const connector = make_connector({
      download_file_version: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { statusCode: 404 }))
        .mockImplementation(stub_drive_version_download()),
    });

    await capture(connector, versions, false);

    expect(versions.pending[ITEM.item_id]?.not_found?.['1.0']?.reads).toBe(1);
    // 1.0 is the oldest, so the watermark may not move past it.
    expect(versions.watermarks[ITEM.item_id]).toBeUndefined();
  });

  it('carries the streak into the next capture of the file', async () => {
    const since = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const versions = make_versions({
      pending: { [ITEM.item_id]: { not_found: { '1.0': { reads: 2, since } } } },
    });
    const connector = make_connector({
      download_file_version: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { statusCode: 404 }))
        .mockImplementation(stub_drive_version_download()),
    });

    const outcome = await capture(connector, versions, true);

    expect(outcome).toMatchObject({ versions_unavailable: 1, versions_failed: 0 });
    expect(versions.pending).toEqual({});
    expect(versions.watermarks[ITEM.item_id]).toEqual({
      last_modified_at: '2026-02-01T00:00:00Z',
      version_ids: ['2.0'],
    });
  });
});

describe('forget_pending_versions', () => {
  it('drops the pending record of a deleted file', () => {
    const versions = make_versions({ pending: { [ITEM.item_id]: {}, other: {} } });

    forget_pending_versions(versions, ITEM.item_id);

    expect(versions.pending).toEqual({ other: {} });
  });
});
