import { describe, it, expect, vi } from 'vitest';
import type { OneDriveConnector, OneDriveDeltaItem, TenantContext } from '@wisecom/atlas-types';
import {
  process_delta_item,
  type DriveTrackingState,
  type VersionStats,
} from '@/services/onedrive-delta-item-processor';
import type { RunVersionCollector } from '@/services/onedrive-version-sync';

// Issue #139: a removed item arrives with no name and no download URL. It must
// become a deleted manifest entry, never a download attempt, and never a
// failed-item ledger entry.

const OWNER_ID = 'owner-1';
const SNAPSHOT_ID = 'od-snap-test';

const EMPTY_VERSIONS: RunVersionCollector = { watermarks: {}, rows: new Map() };
function make_state(overrides: Partial<DriveTrackingState> = {}): DriveTrackingState {
  return {
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    ...overrides,
  };
}

function make_connector(): { connector: OneDriveConnector; downloads: string[] } {
  const downloads: string[] = [];
  const connector = {
    download_file_content: vi.fn(async (item: OneDriveDeltaItem) => {
      downloads.push(item.item_id);
      return Buffer.from('content');
    }),
    list_file_versions: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveConnector;
  return { connector, downloads };
}

function make_ctx(): TenantContext {
  return {
    tenant_id: 't',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
    },
    encrypt: (buffer: Buffer) => buffer,
  } as unknown as TenantContext;
}

function deleted_item(item_id: string): OneDriveDeltaItem {
  // The shape Graph actually returns: no file_name, no download_url.
  return {
    item_id,
    drive_id: 'd1',
    kind: 'file',
    file_name: '',
    parent_path: '/Folder',
    size_bytes: 0,
    deleted: true,
  };
}

const version_stats = (): VersionStats => ({
  total_versions_stored: 0,
  total_versions_unavailable: 0,
  total_versions_failed: 0,
});

describe('process_delta_item deletion handling (issue #139)', () => {
  it('records a deleted entry and never attempts a download', async () => {
    const { connector, downloads } = make_connector();
    const state = make_state({
      previous_name_by_file_id: { i1: 'Report.docx' },
      previous_path_by_file_id: { i1: '/Folder' },
      previous_kind_by_file_id: { i1: 'file' },
    });

    const outcome = await process_delta_item(
      connector,
      deleted_item('i1'),
      OWNER_ID,
      SNAPSHOT_ID,
      make_ctx(),
      state,
      version_stats(),
      () => {},
      EMPTY_VERSIONS,
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.deleted_items).toBe(1);
    expect(outcome.entry?.change_type).toBe('deleted');
    expect(outcome.entry?.storage_key).toBeUndefined();
    expect(downloads).toEqual([]);
  });

  it('names the deleted entry from the last known name, since Graph omits it', async () => {
    const { connector } = make_connector();
    const state = make_state({
      previous_name_by_file_id: { i1: 'Budget.xlsx' },
      previous_path_by_file_id: { i1: '/Folder' },
      previous_kind_by_file_id: { i1: 'file' },
    });

    const outcome = await process_delta_item(
      connector,
      deleted_item('i1'),
      OWNER_ID,
      SNAPSHOT_ID,
      make_ctx(),
      state,
      version_stats(),
      () => {},
      EMPTY_VERSIONS,
    );

    expect(outcome.entry?.file_name).toBe('Budget.xlsx');
  });

  it('still records a deletion for an item it never saw stored', async () => {
    const { connector, downloads } = make_connector();

    const outcome = await process_delta_item(
      connector,
      deleted_item('unknown-item'),
      OWNER_ID,
      SNAPSHOT_ID,
      make_ctx(),
      make_state(),
      version_stats(),
      () => {},
      EMPTY_VERSIONS,
    );

    expect(outcome.deleted_items).toBe(1);
    expect(outcome.entry?.file_name).toBe('');
    expect(downloads).toEqual([]);
  });

  it('downloads a live file, confirming the deletion branch is not over-eager', async () => {
    const { connector, downloads } = make_connector();

    const outcome = await process_delta_item(
      connector,
      {
        item_id: 'i2',
        drive_id: 'd1',
        kind: 'file',
        file_name: 'Report.docx',
        parent_path: '/',
        size_bytes: 7,
        deleted: false,
        etag: 'etag-1',
        download_url: 'https://example.invalid/content',
      },
      OWNER_ID,
      SNAPSHOT_ID,
      make_ctx(),
      make_state(),
      version_stats(),
      () => {},
      EMPTY_VERSIONS,
    );

    expect(downloads).toEqual(['i2']);
    expect(outcome.entry?.change_type).toBe('created');
    expect(outcome.entry?.storage_key).toBeDefined();
  });
});
