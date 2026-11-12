import 'reflect-metadata';

import { describe, expect, it } from 'vitest';
import type {
  SharePointBackupOptions,
  SharePointBackupResult,
  SharePointDeltaCursor,
  SharePointSnapshotManifest,
} from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  stub_drive_stores,
  stub_graph_drive,
} from '@wisecom/atlas-types/testing/stub-drive-backup-rig';

import { SharePointBackupService } from '@/services/backup/backup.service';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

/**
 * Issue #725: after `delete -s` of the newest snapshot the delta cursor still pointed past the run
 * that wrote it. The next incremental built on the older manifest, resumed the cursor, reported no
 * changes, and the file only the deleted snapshot recorded was in no snapshot.
 */
const SITE = 'contoso.sharepoint.com,site-guid,web-guid';

function harness() {
  const documents = stub_graph_drive('library-documents');
  const archive = stub_graph_drive('library-archive');
  const libraries = [documents, archive];
  const stores = stub_drive_stores<SharePointSnapshotManifest, SharePointDeltaCursor>(
    'sharepoint',
    SITE,
  );
  const connector = {
    list_document_libraries: async () =>
      libraries.map((library) => ({ drive_id: library.drive_id, drive_name: library.drive_id })),
    fetch_delta: async (_tenant: string, _site: string, drive_id: string, link?: string) =>
      libraries.find((library) => library.drive_id === drive_id)!.delta(link),
    fetch_item_by_id: async () => undefined,
    download_file_content: async (item: { item_id: string; etag?: string }) =>
      Buffer.from(`${item.item_id}:${item.etag}`),
    list_file_versions: async () => [],
  };
  const service = new SharePointBackupService(
    tenant_factory_for(stores.ctx),
    connector as never,
    {
      save: stores.save_manifest,
      find_latest_readable: stores.find_latest_readable,
      list_readable_snapshots_by_site: stores.list_readable_snapshots,
    } as never,
    {
      load_version_watermarks: stores.load_version_watermarks,
      write_run_index: stores.write_run_index,
    } as never,
    { load: stores.load_cursor, save: stores.save_cursor } as never,
    stub_owner_leases().leases,
  );
  const run = (options: SharePointBackupOptions = {}): Promise<SharePointBackupResult> =>
    service.backup_site('tenant-1', SITE, options);
  /** The link each library's last delta read resumed from. */
  const last_links = (): (string | undefined)[] =>
    libraries.map((library) => library.requested_links.at(-1));
  return { documents, archive, stores, run, last_links };
}

/** The file names a snapshot's own entries record, sorted. */
function recorded(result: SharePointBackupResult, change: 'live' | 'deleted' = 'live'): string[] {
  return (result.snapshot?.entries ?? [])
    .filter((entry) => (entry.change_type === 'deleted') === (change === 'deleted'))
    .map((entry) => entry.file_name)
    .sort();
}

/** Two backups: one file per library in the first, `Report.docx` only in the second. */
async function two_snapshots() {
  const h = harness();
  h.documents.put_file('Budget.xlsx');
  h.archive.put_file('Minutes.docx');
  const first = await h.run();
  h.documents.put_file('Report.docx');
  const second = await h.run();
  expect(recorded(second)).toEqual(['Report.docx']);
  return { h, first, second };
}

describe('a SharePoint backup after the newest snapshot was deleted', () => {
  it('reads every library in full and captures the file only the deleted snapshot held', async () => {
    const { h, second } = await two_snapshots();

    // delete -s interrupted after the manifest, or a quarantine: the cursor naming it is left.
    h.stores.remove_manifest(second.snapshot!.snapshot_id);
    const third = await h.run();

    expect(h.last_links()).toEqual([undefined, undefined]);
    expect(recorded(third)).toEqual(['Budget.xlsx', 'Minutes.docx', 'Report.docx']);
    expect(third.summary.healthy).toBe(true);
    expect(h.stores.saved_cursors.at(-1)?.snapshot_id).toBe(third.snapshot?.snapshot_id);
  });

  it('says why it did not resume, naming the missing snapshot', async () => {
    const { h, second } = await two_snapshots();
    h.stores.remove_manifest(second.snapshot!.snapshot_id);

    const third = await h.run();

    expect(third.summary.warnings).toEqual([
      expect.stringMatching(
        new RegExp(`Not resuming.*${second.snapshot!.snapshot_id}.*every library in full`),
      ),
    ]);
  });

  it('captures the file again when the delete also removed the cursor', async () => {
    const { h, second } = await two_snapshots();
    h.stores.remove_manifest(second.snapshot!.snapshot_id);
    h.stores.saved_cursors.length = 0;

    const third = await h.run();

    expect(recorded(third)).toEqual(['Budget.xlsx', 'Minutes.docx', 'Report.docx']);
    expect(third.summary.warnings).toEqual([]);
  });

  it('records again the removal only the deleted snapshot recorded', async () => {
    const { h } = await two_snapshots();
    h.documents.remove_file('Report.docx');
    const removal = await h.run();
    expect(recorded(removal, 'deleted')).toHaveLength(1);

    h.stores.remove_manifest(removal.snapshot!.snapshot_id);
    const next = await h.run();

    // An older manifest lists Report.docx as live; without a new tombstone a restore brings it back.
    expect(recorded(next)).toEqual(['Budget.xlsx', 'Minutes.docx']);
    expect(next.snapshot?.entries.filter((e) => e.change_type === 'deleted')).toMatchObject([
      { file_id: 'id-Report.docx', drive_id: 'library-documents' },
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

    expect(h.last_links().every((link) => link?.startsWith('link:'))).toBe(true);
    expect(quiet.snapshot).toBeUndefined();
    expect(quiet.summary.warnings).toEqual([]);
  });
});

describe('the snapshot a SharePoint cursor is bound to', () => {
  it('is the snapshot the run wrote', async () => {
    const { h, second } = await two_snapshots();

    expect(h.stores.saved_cursors.at(-1)?.snapshot_id).toBe(second.snapshot?.snapshot_id);
  });

  it('stays the surviving newest snapshot after a run that changed nothing', async () => {
    const { h, second } = await two_snapshots();

    const quiet = await h.run();

    expect(quiet.snapshot).toBeUndefined();
    expect(h.last_links().every((link) => link?.startsWith('link:'))).toBe(true);
    expect(h.stores.saved_cursors.at(-1)?.snapshot_id).toBe(second.snapshot?.snapshot_id);
    expect(h.stores.stored_manifests()).toHaveLength(2);
  });

  it('is null for a site whose runs never produced a snapshot, and such a cursor resumes', async () => {
    const h = harness();

    const empty = await h.run();
    const again = await h.run();

    expect(empty.snapshot).toBeUndefined();
    expect(h.stores.saved_cursors.map((cursor) => cursor.snapshot_id)).toEqual([null, null]);
    expect(h.documents.requested_links).toEqual([undefined, 'link:0']);
    expect(again.summary.warnings).toEqual([]);
  });
});

describe('a SharePoint cursor written before cursors recorded their snapshot', () => {
  /** Rewrites the stored cursor the way an earlier release saved it. */
  function forget_binding(h: ReturnType<typeof harness>): void {
    const { snapshot_id: _snapshot_id, ...legacy } = h.stores.saved_cursors.at(-1)!;
    h.stores.saved_cursors.push(legacy);
  }

  it('is still resumed while a snapshot exists', async () => {
    const { h } = await two_snapshots();
    forget_binding(h);
    h.archive.put_file('Notes.txt');

    const third = await h.run();

    expect(h.last_links().every((link) => link?.startsWith('link:'))).toBe(true);
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

    expect(h.last_links()).toEqual([undefined, undefined]);
    expect(recorded(third)).toEqual(['Budget.xlsx', 'Minutes.docx', 'Report.docx']);
  });
});
