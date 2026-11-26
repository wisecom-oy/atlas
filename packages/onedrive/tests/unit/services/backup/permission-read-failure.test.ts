import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DrivePermission,
  OneDriveBackupResult,
  OneDriveDeltaCursor,
  OneDriveManifestEntry,
  OneDriveSnapshotManifest,
} from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  stub_drive_stores,
  stub_graph_drive,
} from '@wisecom/atlas-types/testing/stub-drive-backup-rig';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import {
  NOT_FOUND_CONFIRMATION_READS,
  NOT_FOUND_CONFIRMATION_WINDOW_MS,
} from '@wisecom/atlas-core/services/shared/not-found-streak';
import { PERMISSION_READ_FAILURE_REASON } from '@wisecom/atlas-drive/backup/unread-permissions';
import { digest_permissions } from '@wisecom/atlas-drive/permissions/permission-digest';
import { OneDriveBackupService } from '@/services/backup/backup.service';

/**
 * Issue #856: a permission read that failed for a shared item was only a warning. A sharing-only
 * change was never recorded, a content change was stored without its grants, and the run reported
 * HEALTHY. The failure is now listed against the item and read again on the next run.
 */
const OWNER = '00000000-0000-0000-0000-00000000abcd';
const FILE_ID = 'id-Report.docx';
const GRANT: DrivePermission = { roles: ['write'], granted_to: { type: 'user', id: 'jane-id' } };
const START = new Date('2026-11-01T00:00:00.000Z');

function harness() {
  const drive = stub_graph_drive();
  const fault = { permission_read_refused: false, reread_not_found: false };
  const stores = stub_drive_stores<OneDriveSnapshotManifest, OneDriveDeltaCursor>(
    'onedrive',
    OWNER,
  );
  const fetch_item_permissions = vi.fn(async (_drive: string, ids: readonly string[]) => {
    const found = new Map<string, readonly DrivePermission[]>();
    if (fault.permission_read_refused) return found;
    for (const id of ids) found.set(id, drive.permissions_of(id) ?? []);
    return found;
  });
  const connector = {
    list_drives: async () => [{ drive_id: drive.drive_id, drive_name: 'OneDrive' }],
    fetch_delta: async (_tenant: string, _owner: string, _drive: string, link?: string) =>
      drive.delta(link),
    fetch_item_by_id: async (_t: string, _o: string, _d: string, item_id: string) =>
      fault.reread_not_found
        ? undefined
        : drive.delta().items.find((item) => item.item_id === item_id),
    fetch_item_permissions,
    download_file_content: async (item: { item_id: string; etag?: string }) =>
      Buffer.from(`${item.item_id}:${item.etag}`),
    list_file_versions: async () => [],
  };
  const manifests = {
    save: stores.save_manifest,
    find_latest_readable: stores.find_latest_readable,
    list_readable_snapshots_by_owner: stores.list_readable_snapshots,
    find_by_snapshot: async (_ctx: unknown, _owner: string, snapshot_id: string) =>
      stores.stored_manifests().find((manifest) => manifest.snapshot_id === snapshot_id),
    ...drive_chain_reads('onedrive'),
  };
  const service = new OneDriveBackupService(
    tenant_factory_for(stores.ctx),
    connector as never,
    manifests as never,
    {
      load_version_watermarks: stores.load_version_watermarks,
      write_run_index: stores.write_run_index,
    } as never,
    { load: stores.load_cursor, save: stores.save_cursor } as never,
    stub_owner_leases().leases,
  );
  let clock = START.getTime();
  // An hour between runs, so every snapshot has its own time and the chain orders them.
  const advance = (ms: number): void => {
    clock += ms;
    vi.setSystemTime(clock);
  };
  const run = (): Promise<OneDriveBackupResult> => {
    advance(60 * 60 * 1000);
    return service.backup_onedrive('tenant-1', OWNER);
  };
  const cursor = (): OneDriveDeltaCursor => stores.saved_cursors.at(-1)!;
  const report_entries = (): OneDriveManifestEntry[] =>
    stores
      .stored_manifests()
      .flatMap((manifest) => manifest.entries)
      .filter((entry) => entry.file_id === FILE_ID);
  return { drive, fault, run, advance, cursor, report_entries, fetch_item_permissions };
}

describe('OneDrive permission read that fails (#856)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('lists a sharing-only change, reports the run unhealthy, and records it on the next run', async () => {
    const h = harness();
    h.drive.put_file('Report.docx');
    await h.run();
    h.drive.share_file('Report.docx', [GRANT]);
    h.fault.permission_read_refused = true;

    const failed = await h.run();

    expect(failed.summary.healthy).toBe(false);
    expect(h.cursor().failed_items?.[FILE_ID]).toMatchObject({
      reason: PERMISSION_READ_FAILURE_REASON,
      attempts: 1,
    });
    expect(h.report_entries()).toHaveLength(1);

    h.fault.permission_read_refused = false;
    const recovered = await h.run();

    expect(recovered.summary.healthy).toBe(true);
    expect(h.cursor().failed_items).toEqual({});
    expect(h.report_entries().at(-1)).toMatchObject({
      change_type: 'permissions_changed',
      permissions: [GRANT],
    });
    expect(h.cursor().permission_digest_by_item_id?.[FILE_ID]).toBe(digest_permissions([GRANT]));
  });

  it("stores a content change with the earlier grants, and keeps the cursor's digest", async () => {
    const h = harness();
    h.drive.put_file('Report.docx');
    h.drive.share_file('Report.docx', [GRANT]);
    await h.run();
    h.drive.put_file('Report.docx');
    h.fault.permission_read_refused = true;

    const failed = await h.run();

    expect(failed.summary.healthy).toBe(false);
    expect(failed.summary.files_stored).toBe(1);
    expect(h.report_entries()).toHaveLength(2);
    expect(h.report_entries().at(-1)).toMatchObject({
      change_type: 'updated',
      permissions: [GRANT],
    });
    expect(h.cursor().permission_digest_by_item_id?.[FILE_ID]).toBe(digest_permissions([GRANT]));

    h.fault.permission_read_refused = false;
    const recovered = await h.run();

    expect(recovered.summary.healthy).toBe(true);
    expect(h.cursor().failed_items).toEqual({});
    expect(h.report_entries()).toHaveLength(2);
  });

  it('clears the listed item when delta reports it deleted', async () => {
    const h = harness();
    h.drive.put_file('Report.docx');
    await h.run();
    h.drive.share_file('Report.docx', [GRANT]);
    h.fault.permission_read_refused = true;
    await h.run();
    h.fault.permission_read_refused = false;
    h.drive.remove_file('Report.docx');

    const result = await h.run();

    expect(result.summary.healthy).toBe(true);
    expect(h.cursor().failed_items).toEqual({});
  });

  it('clears an item that keeps answering "not found" once the deletion is confirmed', async () => {
    const h = harness();
    h.drive.put_file('Report.docx');
    await h.run();
    h.drive.share_file('Report.docx', [GRANT]);
    h.fault.permission_read_refused = true;
    await h.run();
    h.fault.reread_not_found = true;

    for (let read = 1; read < NOT_FOUND_CONFIRMATION_READS; read++) {
      await h.run();
      expect(h.cursor().failed_items?.[FILE_ID]).toMatchObject({
        attempts: 1,
        not_found: { reads: read },
      });
    }
    h.advance(NOT_FOUND_CONFIRMATION_WINDOW_MS);
    await h.run();

    expect(h.cursor().failed_items).toEqual({});
  });

  it('reads the permissions of shared items only', async () => {
    const h = harness();
    h.drive.put_file('Report.docx');
    h.drive.put_file('Budget.xlsx');
    await h.run();
    expect(h.fetch_item_permissions).not.toHaveBeenCalled();

    h.drive.share_file('Report.docx', [GRANT]);
    h.drive.put_file('Budget.xlsx');
    await h.run();

    expect(h.fetch_item_permissions).toHaveBeenCalledTimes(1);
    expect(h.fetch_item_permissions).toHaveBeenCalledWith(h.drive.drive_id, [FILE_ID]);
  });
});
