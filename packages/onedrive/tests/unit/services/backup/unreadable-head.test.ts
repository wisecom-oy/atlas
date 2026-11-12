/**
 * Issue #709: a drive run resumes from its delta cursor and read no manifest, so a damaged newest
 * manifest went unreported and the run exited 0, where Outlook names the object and exits 9.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  LatestReadableManifest,
  OneDriveDeltaCursor,
  OneDriveDeltaItem,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { stub_tenant_create_content_hmac } from '@wisecom/atlas-types/testing/stub-tenant-create-content-hmac';
import { latest_readable, readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import { OneDriveBackupService } from '@/services/backup/backup.service';

const OWNER_ID = 'owner-1';
const DAMAGED_KEY = `onedrive/manifests/${OWNER_ID}/od-snap-9999-abc.json`;

const OLDER = {
  owner_id: OWNER_ID,
  snapshot_id: 'od-snap-1',
  created_at: new Date('2026-09-01T00:00:00Z'),
  entries: [],
} as unknown as OneDriveSnapshotManifest;

const CURSOR: OneDriveDeltaCursor = {
  owner_id: OWNER_ID,
  delta_link_by_drive: { d1: 'link-1' },
  previous_path_by_file_id: { report: '/Docs' },
  previous_name_by_file_id: { report: 'report.docx' },
  previous_etag_by_file_id: { report: 'etag-old' },
  previous_kind_by_file_id: { report: 'file' },
  updated_at: '2026-09-01T00:00:00Z',
};

const DAMAGED_HEAD: LatestReadableManifest<OneDriveSnapshotManifest> = {
  manifest: OLDER,
  unreadable_keys: [DAMAGED_KEY],
};

function changed_file(item_id: string): OneDriveDeltaItem {
  return {
    item_id,
    drive_id: 'd1',
    kind: 'file',
    file_name: `${item_id}.docx`,
    parent_path: '/Docs',
    size_bytes: 8,
    deleted: false,
    etag: `etag-${item_id}`,
  };
}

/** Runs one incremental backup whose delta returns `items` and whose head lookup returns `head`. */
function run_backup(items: OneDriveDeltaItem[], head: LatestReadableManifest<unknown>) {
  const connector = {
    list_drives: async () => [{ drive_id: 'd1', drive_name: 'OneDrive' }],
    fetch_delta: async () => ({
      drive_id: 'd1',
      delta_link: 'link-2',
      items,
      reset_detected: false,
    }),
    fetch_item_by_id: vi.fn(),
    download_file_content: async (item: OneDriveDeltaItem) => Buffer.from(item.item_id),
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
    create_content_hmac: stub_tenant_create_content_hmac,
  } as unknown as TenantContext;
  const factory = { create: async () => ctx } as unknown as TenantContextFactory;
  const manifests = {
    save: vi.fn(),
    find_latest_readable: vi.fn(async () => head),
    list_readable_snapshots_by_owner: vi.fn(async () => readable_manifests([OLDER])),
  };
  const cursors = { load: async () => CURSOR, save: vi.fn() };
  const service = new OneDriveBackupService(
    factory,
    connector as never,
    manifests as never,
    { load_version_watermarks: async () => ({}), write_run_index: vi.fn() } as never,
    cursors as never,
  );
  return { result: service.backup_onedrive('t', OWNER_ID), manifests, cursors };
}

describe('OneDrive backup when the newest manifest is unreadable (issue #709)', () => {
  it('names the damaged key on an incremental run and still writes its snapshot', async () => {
    const run = run_backup([changed_file('report')], DAMAGED_HEAD);

    const result = await run.result;

    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
    expect(result.snapshot?.entries.map((e) => e.file_id)).toEqual(['report']);
    expect(run.manifests.save).toHaveBeenCalledTimes(1);
    expect(run.cursors.save).toHaveBeenCalledTimes(1);
    // An incremental run still reads no full listing: the head check is the only manifest read.
    expect(run.manifests.list_readable_snapshots_by_owner).not.toHaveBeenCalled();
  });

  it('names the damaged key on a run with no changes', async () => {
    const result = await run_backup([], DAMAGED_HEAD).result;

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.no_snapshot_reason).toBe('no_changes');
    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
  });

  it('checks the head before it saves its own manifest, which would hide the damaged one', async () => {
    const run = run_backup([changed_file('report')], DAMAGED_HEAD);

    await run.result;

    const lookup = run.manifests.find_latest_readable.mock.invocationCallOrder[0]!;
    const save = run.manifests.save.mock.invocationCallOrder[0]!;
    expect(lookup).toBeLessThan(save);
  });

  it('reports nothing when the newest manifest reads cleanly', async () => {
    const result = await run_backup([changed_file('report')], latest_readable(OLDER)).result;

    expect(result.summary.unreadable_keys).toBeUndefined();
  });
});
