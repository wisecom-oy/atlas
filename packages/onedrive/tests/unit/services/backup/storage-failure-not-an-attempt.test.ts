import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type {
  ObjectStorage,
  OneDriveBackupResult,
  OneDriveDeltaCursor,
  OneDriveSnapshotManifest,
} from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  stub_drive_stores,
  stub_graph_drive,
} from '@wisecom/atlas-types/testing/stub-drive-backup-rig';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { OneDriveBackupService } from '@/services/backup/backup.service';

/**
 * Issue #917: a failed write of a file's content is the storage's failure, not the file's. It
 * fails the drive, which keeps its delta link so the file is read again, and records nothing in
 * the failed-item ledger, so storage that stays full or broken never uses up the file's attempts.
 */
const OWNER = '00000000-0000-0000-0000-00000000abcd';
const FILE_ID = 'id-Report.docx';

/** An S3 `500 InternalError` after the SDK's retries, as the AWS SDK raises it. */
const STORAGE_FAILURE = Object.assign(new Error('We encountered an internal error'), {
  name: 'InternalError',
  $metadata: { httpStatusCode: 500, attempts: 3 },
});

function harness() {
  const drive = stub_graph_drive();
  const stores = stub_drive_stores<OneDriveSnapshotManifest, OneDriveDeltaCursor>(
    'onedrive',
    OWNER,
  );
  const storage = { failing: false };
  const put = stores.ctx.storage.put.bind(stores.ctx.storage);
  stores.ctx.storage.put = (async (key: string, ...rest: unknown[]) => {
    if (storage.failing && key.startsWith('onedrive/data/')) throw STORAGE_FAILURE;
    return (put as (...args: unknown[]) => Promise<void>)(key, ...rest);
  }) as ObjectStorage['put'];
  const connector = {
    list_drives: async () => [{ drive_id: drive.drive_id, drive_name: 'OneDrive' }],
    fetch_delta: async (_tenant: string, _owner: string, _drive: string, link?: string) =>
      drive.delta(link),
    fetch_item_by_id: async (_t: string, _o: string, _d: string, item_id: string) =>
      drive.delta().items.find((item) => item.item_id === item_id),
    download_file_content: async (item: { item_id: string; etag?: string }) =>
      Buffer.from(`${item.item_id}:${item.etag}`),
    list_file_versions: async () => [],
  };
  const service = new OneDriveBackupService(
    tenant_factory_for(stores.ctx),
    connector as never,
    {
      save: stores.save_manifest,
      find_latest_readable: stores.find_latest_readable,
      list_readable_snapshots_by_owner: stores.list_readable_snapshots,
    } as never,
    {
      load_version_watermarks: stores.load_version_watermarks,
      write_run_index: stores.write_run_index,
    } as never,
    { load: stores.load_cursor, save: stores.save_cursor } as never,
    stub_owner_leases().leases,
  );
  const run = (): Promise<OneDriveBackupResult> => service.backup_onedrive('tenant-1', OWNER);
  const cursor = (): OneDriveDeltaCursor => stores.saved_cursors.at(-1)!;
  return { drive, storage, stores, run, cursor };
}

describe('a OneDrive storage failure while storing a file (#917)', () => {
  it('fails the drive and records no ledger entry, then stores the file once storage recovers', async () => {
    const h = harness();
    h.drive.put_file('Budget.xlsx');
    await h.run();
    const link_before = h.cursor().delta_link_by_drive[h.drive.drive_id];
    h.drive.put_file('Report.docx');
    h.storage.failing = true;

    const failed = await h.run();

    expect(failed.summary.errors.join('\n')).toContain('We encountered an internal error');
    expect(failed.summary.healthy).toBe(false);
    expect(h.cursor().failed_items?.[FILE_ID]).toBeUndefined();
    expect(h.cursor().delta_link_by_drive[h.drive.drive_id]).toBe(link_before);

    h.storage.failing = false;
    const recovered = await h.run();

    expect(recovered.summary.errors).toEqual([]);
    expect(recovered.summary.files_stored).toBe(1);
    expect(h.cursor().failed_items?.[FILE_ID]).toBeUndefined();
  });
});
