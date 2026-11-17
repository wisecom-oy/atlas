import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type {
  OneDriveBackupOptions,
  OneDriveBackupResult,
  OneDriveDeltaCursor,
  OneDriveSnapshotManifest,
} from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  stub_drive_stores,
  stub_graph_drive,
} from '@wisecom/atlas-types/testing/stub-drive-backup-rig';

import { OneDriveBackupService } from '@/services/backup/backup.service';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

/**
 * Issue #725: after `delete -s` of the newest snapshot the delta cursor still pointed past the run
 * that wrote it. The next incremental built on the older manifest, resumed the cursor, reported no
 * changes, and the file only the deleted snapshot recorded was in no snapshot.
 */
const OWNER = '00000000-0000-0000-0000-00000000abcd';

function harness() {
  const drive = stub_graph_drive();
  const stores = stub_drive_stores<OneDriveSnapshotManifest, OneDriveDeltaCursor>(
    'onedrive',
    OWNER,
  );
  const connector = {
    list_drives: async () => [{ drive_id: drive.drive_id, drive_name: 'OneDrive' }],
    fetch_delta: async (_tenant: string, _owner: string, _drive: string, link?: string) =>
      drive.delta(link),
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
  const run = (options: OneDriveBackupOptions = {}): Promise<OneDriveBackupResult> =>
    service.backup_onedrive('tenant-1', OWNER, options);
  return { drive, stores, run };
}

/** The live file names a snapshot's own entries record, sorted. */
function recorded(result: OneDriveBackupResult, change: 'live' | 'deleted' = 'live'): string[] {
  return (result.snapshot?.entries ?? [])
    .filter((entry) => (entry.change_type === 'deleted') === (change === 'deleted'))
    .map((entry) => entry.file_name)
    .sort();
}

/** Two backups: `Budget.xlsx` in the first, `Report.docx` only in the second. */
async function two_snapshots() {
  const h = harness();
  h.drive.put_file('Budget.xlsx');
  const first = await h.run();
  h.drive.put_file('Report.docx');
  const second = await h.run();
  expect(recorded(second)).toEqual(['Report.docx']);
  return { h, first, second };
}

describe('a OneDrive backup after the newest snapshot was deleted', () => {
  it('reads the drive in full and captures the file only the deleted snapshot held', async () => {
    const { h, second } = await two_snapshots();

    // delete -s interrupted after the manifest, or a quarantine: the cursor naming it is left.
    h.stores.remove_manifest(second.snapshot!.snapshot_id);
    const third = await h.run();

    expect(h.drive.requested_links.at(-1)).toBeUndefined();
    expect(recorded(third)).toEqual(['Budget.xlsx', 'Report.docx']);
    expect(third.summary.healthy).toBe(true);
    expect(h.stores.saved_cursors.at(-1)?.snapshot_id).toBe(third.snapshot?.snapshot_id);
  });

  it('says why it did not resume, naming the missing snapshot', async () => {
    const { h, second } = await two_snapshots();
    h.stores.remove_manifest(second.snapshot!.snapshot_id);

    const third = await h.run();

    expect(third.summary.warnings).toEqual([
      expect.stringMatching(
        new RegExp(`Not resuming.*${second.snapshot!.snapshot_id}.*every drive in full`),
      ),
    ]);
  });

  it('captures the file again when the delete also removed the cursor', async () => {
    const { h, second } = await two_snapshots();
    h.stores.remove_manifest(second.snapshot!.snapshot_id);
    h.stores.saved_cursors.length = 0;

    const third = await h.run();

    expect(recorded(third)).toEqual(['Budget.xlsx', 'Report.docx']);
    expect(third.summary.warnings).toEqual([]);
  });

  it('records again the removal only the deleted snapshot recorded', async () => {
    const h = harness();
    h.drive.put_file('Budget.xlsx');
    h.drive.put_file('Report.docx');
    await h.run();
    h.drive.remove_file('Report.docx');
    const second = await h.run();
    expect(recorded(second, 'deleted')).toHaveLength(1);

    h.stores.remove_manifest(second.snapshot!.snapshot_id);
    const third = await h.run();

    // The older manifest lists Report.docx as live; without a new tombstone a restore brings it back.
    expect(recorded(third)).toEqual(['Budget.xlsx']);
    expect(third.snapshot?.entries.filter((e) => e.change_type === 'deleted')).toMatchObject([
      { file_id: 'id-Report.docx' },
    ]);
  });

  it('seeds the version watermarks again instead of trusting the outlived cursor', async () => {
    const { h, second } = await two_snapshots();
    const seeds_before = h.stores.watermark_seeds();
    h.stores.remove_manifest(second.snapshot!.snapshot_id);

    await h.run();

    expect(h.stores.watermark_seeds()).toBe(seeds_before + 1);
  });

  it('resumes again on the run after the full one', async () => {
    const { h, second } = await two_snapshots();
    h.stores.remove_manifest(second.snapshot!.snapshot_id);
    await h.run();

    const quiet = await h.run();

    expect(h.drive.requested_links.at(-1)).toMatch(/^link:/);
    expect(quiet.snapshot).toBeUndefined();
    expect(quiet.summary.warnings).toEqual([]);
  });
});

describe('the snapshot a OneDrive cursor is bound to', () => {
  it('is the snapshot the run wrote', async () => {
    const { h, second } = await two_snapshots();

    expect(h.stores.saved_cursors.at(-1)?.snapshot_id).toBe(second.snapshot?.snapshot_id);
  });

  it('stays the surviving newest snapshot after a run that changed nothing', async () => {
    const { h, second } = await two_snapshots();

    const quiet = await h.run();

    expect(quiet.snapshot).toBeUndefined();
    expect(h.drive.requested_links.at(-1)).toMatch(/^link:/);
    expect(h.stores.saved_cursors.at(-1)?.snapshot_id).toBe(second.snapshot?.snapshot_id);
    expect(h.stores.stored_manifests()).toHaveLength(2);
  });

  it('is null for an owner whose runs never produced a snapshot, and such a cursor resumes', async () => {
    const h = harness();

    const empty = await h.run();
    const again = await h.run();

    expect(empty.snapshot).toBeUndefined();
    expect(h.stores.saved_cursors.map((cursor) => cursor.snapshot_id)).toEqual([null, null]);
    expect(h.drive.requested_links).toEqual([undefined, 'link:0']);
    expect(again.summary.warnings).toEqual([]);
  });
});

describe('a OneDrive cursor written before cursors recorded their snapshot', () => {
  /** Rewrites the stored cursor the way an earlier release saved it. */
  function forget_binding(h: ReturnType<typeof harness>): void {
    const { snapshot_id: _snapshot_id, ...legacy } = h.stores.saved_cursors.at(-1)!;
    h.stores.saved_cursors.push(legacy);
  }

  it('is still resumed while a snapshot exists', async () => {
    const { h } = await two_snapshots();
    forget_binding(h);
    h.drive.put_file('Notes.txt');

    const third = await h.run();

    expect(h.drive.requested_links.at(-1)).toMatch(/^link:/);
    expect(recorded(third)).toEqual(['Notes.txt']);
    expect(third.summary.warnings).toEqual([]);
  });

  it('is bound to the newest snapshot by its first run, even one that changes nothing', async () => {
    const { h, second } = await two_snapshots();
    forget_binding(h);

    await h.run();

    expect(h.stores.saved_cursors.at(-1)?.snapshot_id).toBe(second.snapshot?.snapshot_id);
  });

  it('is not resumed once no snapshot exists', async () => {
    const { h, first, second } = await two_snapshots();
    forget_binding(h);
    h.stores.remove_manifest(first.snapshot!.snapshot_id);
    h.stores.remove_manifest(second.snapshot!.snapshot_id);

    const third = await h.run();

    expect(h.drive.requested_links.at(-1)).toBeUndefined();
    expect(recorded(third)).toEqual(['Budget.xlsx', 'Report.docx']);
  });
});
