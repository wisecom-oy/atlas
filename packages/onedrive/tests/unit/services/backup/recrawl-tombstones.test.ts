/**
 * Issue #435: a full enumeration lists what exists, not what was removed, so a file deleted since
 * the last run must be tombstoned by comparing the enumeration with the previous chain.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import type {
  OneDriveBackupResult,
  OneDriveDeltaCursor,
  OneDriveDeltaItem,
  OneDriveManifestEntry,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveBackupService } from '@/services/backup/backup.service';

const OWNER_ID = 'owner-1';

function make_item(item_id: string, drive_id = 'd1'): OneDriveDeltaItem {
  return {
    item_id,
    drive_id,
    kind: 'file',
    file_name: `${item_id}.docx`,
    parent_path: '/Docs',
    size_bytes: 8,
    deleted: false,
    etag: `etag-${item_id}`,
  };
}

function stored_entry(
  file_id: string,
  drive_id = 'd1',
  parent_path = '/Docs',
): OneDriveManifestEntry {
  return {
    file_id,
    drive_id,
    file_name: `${file_id}.docx`,
    parent_path,
    size_bytes: 8,
    storage_key: `onedrive/data/${OWNER_ID}/${file_id}`,
    checksum: 'c'.repeat(64),
    backup_at: '2026-09-01T00:00:00.000Z',
    change_type: 'created',
  };
}

const PREVIOUS: OneDriveSnapshotManifest = {
  id: 'm-1',
  tenant_id: 't',
  owner_id: OWNER_ID,
  snapshot_id: 'od-snap-1',
  created_at: new Date('2026-09-01T00:00:00Z'),
  total_files: 4,
  total_size_bytes: 32,
  entries: [
    stored_entry('report'),
    stored_entry('budget'),
    stored_entry('photo', 'd2'),
    stored_entry('archive', 'd1', '/Archive'),
  ],
};

const CURSOR: OneDriveDeltaCursor = {
  owner_id: OWNER_ID,
  delta_link_by_drive: { d1: 'link-d1', d2: 'link-d2' },
  previous_path_by_file_id: {},
  previous_name_by_file_id: {},
  previous_etag_by_file_id: {},
  previous_kind_by_file_id: {},
  updated_at: '2026-09-01T00:00:00Z',
};

interface DriveDelta {
  readonly items: OneDriveDeltaItem[];
  readonly reset_detected?: boolean;
}

interface RunOptions {
  readonly force_full?: boolean;
  readonly folder_scope?: string;
  readonly stop_after_first_download?: boolean;
}

interface Run {
  readonly result: Promise<OneDriveBackupResult>;
  readonly list_snapshots_by_owner: Mock;
}

function run_backup(deltas: Record<string, DriveDelta>, options: RunOptions = {}): Run {
  const downloaded: string[] = [];
  const connector = {
    list_drives: async () => Object.keys(deltas).map((id) => ({ drive_id: id, drive_name: id })),
    fetch_delta: async (_tenant: string, _owner: string, drive_id: string) => ({
      drive_id,
      delta_link: `next-${drive_id}`,
      items: deltas[drive_id]!.items,
      reset_detected: deltas[drive_id]!.reset_detected ?? false,
    }),
    fetch_item_by_id: vi.fn(),
    download_file_content: async (item: OneDriveDeltaItem) => {
      downloaded.push(item.item_id);
      return Buffer.from(item.item_id);
    },
    list_file_versions: async () => [],
  };
  const ctx = {
    storage: {
      exists: async () => false,
      put: async () => undefined,
      list: async () => [],
      list_stale: async () => [],
      abort_incomplete_uploads: async () => 0,
    },
    encrypt: (buffer: Buffer) => buffer,
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = { create: async () => ctx } as unknown as TenantContextFactory;
  const list_snapshots_by_owner = vi.fn(async () => [PREVIOUS]);
  const service = new OneDriveBackupService(
    factory,
    connector as never,
    { save: vi.fn(), list_snapshots_by_owner } as never,
    { load_version_watermarks: async () => ({}), write_run_index: vi.fn() } as never,
    { load: async () => CURSOR, save: vi.fn() } as never,
  );
  const result = service.backup_onedrive('t', OWNER_ID, {
    ...(options.force_full !== undefined && { force_full: options.force_full }),
    ...(options.folder_scope !== undefined && { folder_scope: options.folder_scope }),
    should_interrupt: () => options.stop_after_first_download === true && downloaded.length > 0,
  });
  return { result, list_snapshots_by_owner };
}

async function tombstoned(run: Run): Promise<string[]> {
  const entries = (await run.result).snapshot?.entries ?? [];
  return entries.filter((e) => e.change_type === 'deleted').map((e) => e.file_id);
}

describe('OneDrive re-crawl tombstones (issue #435)', () => {
  it('tombstones the files a --full enumeration no longer lists, without a blob', async () => {
    const run = run_backup(
      { d1: { items: [make_item('report')] }, d2: { items: [make_item('photo', 'd2')] } },
      { force_full: true },
    );

    expect(await tombstoned(run)).toEqual(['budget', 'archive']);
    const outcome = await run.result;
    expect(outcome.snapshot?.entries.find((e) => e.file_id === 'budget')).not.toHaveProperty(
      'storage_key',
    );
    expect(outcome.summary.deleted_items).toBe(2);
  });

  it('tombstones only within the drive whose delta reset, never a sibling drive', async () => {
    const run = run_backup({
      d1: { items: [make_item('report')], reset_detected: true },
      d2: { items: [] },
    });

    expect(await tombstoned(run)).toEqual(['budget', 'archive']);
  });

  it('reads no manifest and writes no tombstone on an incremental delta', async () => {
    const run = run_backup({ d1: { items: [make_item('report')] }, d2: { items: [] } });

    expect(await tombstoned(run)).toEqual([]);
    expect(run.list_snapshots_by_owner).not.toHaveBeenCalled();
  });

  it('compares only inside the --folder scope', async () => {
    const run = run_backup(
      { d1: { items: [make_item('report')] }, d2: { items: [make_item('photo', 'd2')] } },
      { folder_scope: '/Docs' },
    );

    expect(await tombstoned(run)).toEqual(['budget']);
  });

  it('writes no tombstone when the run stops before the drive finishes', async () => {
    const run = run_backup(
      { d1: { items: [make_item('report'), make_item('other')] }, d2: { items: [] } },
      { force_full: true, stop_after_first_download: true },
    );

    expect(await tombstoned(run)).toEqual([]);
  });
});
