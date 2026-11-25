import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type {
  OneDriveBackupResult,
  OneDriveDeltaCursor,
  OneDriveSnapshotManifest,
} from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  stub_drive_stores,
  stub_graph_drive,
  type StubDriveDelta,
} from '@wisecom/atlas-types/testing/stub-drive-backup-rig';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { final_delta_link } from '@wisecom/atlas-drive/backup/delta-listing-end';

import { OneDriveBackupService } from '@/services/backup/backup.service';

/**
 * Issue #852: a delta listing whose last page carried neither `@odata.nextLink` nor
 * `@odata.deltaLink` was processed as complete. On a full read its absences were taken for
 * deletions, so the snapshot recorded files that still exist as deleted, and the run was healthy.
 */
const OWNER = '00000000-0000-0000-0000-00000000abcd';

/**
 * How the next delta listing ends. `pager_refuses` is what the Graph pager does with a page that has
 * neither link. `connector_returns_no_link` is a connector that lets such a listing through with
 * its first item only, which the service must refuse on its own.
 */
type ListingEnd = 'delta_link' | 'pager_refuses' | 'connector_returns_no_link';

const CUT_SHORT: readonly ListingEnd[] = ['pager_refuses', 'connector_returns_no_link'];

/** How one run reads the drive: how its listing ends, and why it is a full read if it is one. */
interface RunPlan {
  readonly end: ListingEnd;
  readonly force_full?: boolean;
  readonly resync?: boolean;
}

function end_listing(delta: StubDriveDelta, end: ListingEnd): StubDriveDelta {
  if (end === 'pager_refuses') {
    return { ...delta, delta_link: final_delta_link({}, `drive ${delta.drive_id}`) };
  }
  if (end === 'connector_returns_no_link') {
    return { ...delta, items: delta.items.slice(0, 1), delta_link: '' };
  }
  return delta;
}

function harness() {
  const drive = stub_graph_drive();
  const stores = stub_drive_stores<OneDriveSnapshotManifest, OneDriveDeltaCursor>(
    'onedrive',
    OWNER,
  );
  let next_run: RunPlan = { end: 'delta_link' };
  const connector = {
    list_drives: async () => [{ drive_id: drive.drive_id, drive_name: 'OneDrive' }],
    // A rejected link (410 resyncRequired) makes the real connector enumerate afresh and report it.
    fetch_delta: async (_tenant: string, _owner: string, _drive: string, link?: string) =>
      end_listing(
        next_run.resync === true
          ? { ...drive.delta(undefined), reset_detected: true }
          : drive.delta(link),
        next_run.end,
      ),
    fetch_item_by_id: async () => undefined,
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
  const run = (plan: RunPlan): Promise<OneDriveBackupResult> => {
    next_run = plan;
    return service.backup_onedrive('tenant-1', OWNER, { force_full: plan.force_full === true });
  };
  const saved_link = (): string | undefined =>
    stores.saved_cursors.at(-1)?.delta_link_by_drive[drive.drive_id];
  return { drive, run, saved_link };
}

/** The file names a snapshot's own entries record with the given change, sorted. */
function recorded(result: OneDriveBackupResult, change: 'live' | 'deleted' = 'live'): string[] {
  return (result.snapshot?.entries ?? [])
    .filter((entry) => (entry.change_type === 'deleted') === (change === 'deleted'))
    .map((entry) => entry.file_name)
    .sort();
}

/** A first healthy backup of three files, returning the harness and the link it saved. */
async function backed_up_drive() {
  const h = harness();
  for (const name of ['Budget.xlsx', 'Notes.txt', 'Report.docx']) h.drive.put_file(name);
  const first = await h.run({ end: 'delta_link' });
  expect(recorded(first)).toEqual(['Budget.xlsx', 'Notes.txt', 'Report.docx']);
  return { h, link: h.saved_link() };
}

describe('a OneDrive delta listing that ends without a delta link (#852)', () => {
  it.each(CUT_SHORT)(
    'fails a --full read, tombstones nothing, and reads in full again (%s)',
    async (end) => {
      const { h } = await backed_up_drive();

      const full = await h.run({ end, force_full: true });

      expect(recorded(full, 'deleted')).toEqual([]);
      expect(full.summary.errors).toEqual([expect.stringMatching(/without a delta link/)]);
      expect(full.summary.healthy).toBe(false);
      // `--full` set the old link aside; no link replaces it, so the next run reads in full again.
      expect(h.saved_link()).toBeUndefined();

      const next = await h.run({ end: 'delta_link' });

      expect(h.drive.requested_links.at(-1)).toBeUndefined();
      expect(recorded(next, 'deleted')).toEqual([]);
      expect(next.summary.healthy).toBe(true);
    },
  );

  it.each(CUT_SHORT)(
    'fails the full read after a resync and keeps the old link (%s)',
    async (end) => {
      const { h, link } = await backed_up_drive();

      const resynced = await h.run({ end, resync: true });

      expect(recorded(resynced, 'deleted')).toEqual([]);
      expect(resynced.summary.errors).toEqual([expect.stringMatching(/without a delta link/)]);
      expect(resynced.summary.healthy).toBe(false);
      expect(h.saved_link()).toBe(link);
    },
  );

  it.each(CUT_SHORT)(
    'fails an incremental run and reads its changes next run (%s)',
    async (end) => {
      const { h, link } = await backed_up_drive();
      h.drive.put_file('Draft.docx');

      const cut = await h.run({ end });

      expect(cut.snapshot).toBeUndefined();
      expect(cut.summary.errors).toEqual([expect.stringMatching(/without a delta link/)]);
      expect(cut.summary.healthy).toBe(false);
      expect(h.saved_link()).toBe(link);

      const next = await h.run({ end: 'delta_link' });

      expect(h.drive.requested_links.at(-1)).toBe(link);
      expect(recorded(next)).toEqual(['Draft.docx']);
      expect(next.summary.healthy).toBe(true);
    },
  );

  it('still tombstones a removed file on a full read that ends with a delta link', async () => {
    const { h } = await backed_up_drive();
    h.drive.remove_file('Report.docx');

    const full = await h.run({ end: 'delta_link', force_full: true });

    expect(recorded(full, 'deleted')).toEqual(['Report.docx']);
    expect(full.summary.healthy).toBe(true);
  });
});
