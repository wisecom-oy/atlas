import 'reflect-metadata';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
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
import {
  NOT_FOUND_CONFIRMATION_READS,
  NOT_FOUND_CONFIRMATION_WINDOW_MS,
} from '@wisecom/atlas-core/services/shared/not-found-streak';
import { OneDriveBackupService } from '@/services/backup/backup.service';

/**
 * Issue #850: a listed file whose re-read by id answered `404` once was cleared from the
 * failed-items list. The drive's delta link had already moved past it, so it was missing from
 * every later snapshot while the run reported HEALTHY. A "not found" answer now keeps the file
 * listed until delta reports the deletion or the answer repeats long enough to confirm it.
 */
const OWNER = '00000000-0000-0000-0000-00000000abcd';
const FILE_ID = 'id-Report.docx';
const START = new Date('2026-11-01T00:00:00.000Z');

function harness() {
  const drive = stub_graph_drive();
  const fault = { download_broken: false, reread_not_found: false };
  const stores = stub_drive_stores<OneDriveSnapshotManifest, OneDriveDeltaCursor>(
    'onedrive',
    OWNER,
  );
  const connector = {
    list_drives: async () => [{ drive_id: drive.drive_id, drive_name: 'OneDrive' }],
    fetch_delta: async (_tenant: string, _owner: string, _drive: string, link?: string) =>
      drive.delta(link),
    fetch_item_by_id: async (_t: string, _o: string, _d: string, item_id: string) =>
      fault.reread_not_found
        ? undefined
        : drive.delta().items.find((item) => item.item_id === item_id),
    download_file_content: async (item: { item_id: string; etag?: string }) => {
      if (fault.download_broken) throw new Error('download broken');
      return Buffer.from(`${item.item_id}:${item.etag}`);
    },
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
  const newest_file_ids = (): string[] =>
    stores
      .stored_manifests()
      .at(-1)!
      .entries.map((entry) => entry.file_id);
  return { drive, fault, run, cursor, newest_file_ids };
}

/** Leaves `Report.docx` on the failed-items list after one failed download. */
async function list_report_after_one_failure(h: ReturnType<typeof harness>): Promise<void> {
  h.drive.put_file('Budget.xlsx');
  await h.run();
  h.drive.put_file('Report.docx');
  h.fault.download_broken = true;
  await h.run();
  h.fault.download_broken = false;
  expect(h.cursor().failed_items?.[FILE_ID]?.attempts).toBe(1);
}

describe('OneDrive re-read of a listed file that answers "not found" (#850)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the file listed, spends no attempt, and reports the run unhealthy', async () => {
    const h = harness();
    await list_report_after_one_failure(h);
    h.fault.reread_not_found = true;

    const result = await h.run();

    expect(h.cursor().failed_items?.[FILE_ID]).toMatchObject({
      attempts: 1,
      not_found: { reads: 1 },
      reason: expect.stringContaining('not found'),
    });
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.warnings).toEqual([
      expect.stringContaining('Not backed up: Report.docx'),
    ]);
  });

  it('stores the file on a later run once the re-read answers normally', async () => {
    const h = harness();
    await list_report_after_one_failure(h);
    h.fault.reread_not_found = true;
    await h.run();
    h.fault.reread_not_found = false;

    const result = await h.run();

    expect(h.cursor().failed_items).toEqual({});
    expect(h.newest_file_ids()).toContain(FILE_ID);
    expect(result.summary.healthy).toBe(true);
  });

  it('clears the file in the run where delta reports it deleted', async () => {
    const h = harness();
    await list_report_after_one_failure(h);
    h.drive.remove_file('Report.docx');
    h.fault.reread_not_found = true;

    const result = await h.run();

    expect(h.cursor().failed_items).toEqual({});
    expect(result.summary.healthy).toBe(true);
  });

  it('clears the file once "not found" repeats on enough runs across the window', async () => {
    const h = harness();
    await list_report_after_one_failure(h);
    h.fault.reread_not_found = true;
    const gap_ms = NOT_FOUND_CONFIRMATION_WINDOW_MS / (NOT_FOUND_CONFIRMATION_READS - 1);

    for (let run = 1; run < NOT_FOUND_CONFIRMATION_READS; run++) {
      await h.run();
      expect(h.cursor().failed_items?.[FILE_ID]?.not_found?.reads).toBe(run);
      vi.setSystemTime(new Date(Date.now() + gap_ms));
    }
    const result = await h.run();

    expect(h.cursor().failed_items).toEqual({});
    expect(result.summary.healthy).toBe(true);
  });
});
