import 'reflect-metadata';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SharePointBackupResult,
  SharePointDeltaCursor,
  SharePointFileVersion,
  SharePointSnapshotManifest,
} from '@wisecom/atlas-types';
import { tenant_factory_for } from '@wisecom/atlas-types/testing/stub-contacts-ports';
import {
  stub_drive_stores,
  stub_graph_drive,
} from '@wisecom/atlas-types/testing/stub-drive-backup-rig';
import { stub_drive_version_download } from '@wisecom/atlas-types/testing/stub-drive-version-download';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

import { SharePointBackupService } from '@/services/backup/backup.service';

/**
 * Issue #858: a library item that failed after a file's content was stored left the rerun finding that
 * content deduplicated, and version capture was skipped for good. Issue #855: one 404 on a listed
 * version's content was counted as expired and the watermark moved past it.
 */
const SITE = 'contoso.sharepoint.com,site-guid,web-guid';
const FILE_ID = 'id-Report.docx';
const T0 = new Date('2026-03-01T00:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

const VERSIONS: SharePointFileVersion[] = [
  { version_id: '2.0', last_modified_at: '2026-02-01T00:00:00Z', size_bytes: 20 },
  { version_id: '1.0', last_modified_at: '2026-01-01T00:00:00Z', size_bytes: 10 },
];
const COMPLETE_WATERMARK = { last_modified_at: '2026-02-01T00:00:00Z', version_ids: ['2.0'] };

function not_found(): Error {
  return Object.assign(new Error('Not Found'), { statusCode: 404 });
}

function harness() {
  const drive = stub_graph_drive('library-documents');
  const stores = stub_drive_stores<SharePointSnapshotManifest, SharePointDeltaCursor>(
    'sharepoint',
    SITE,
  );
  const connector = {
    list_document_libraries: async () => [{ drive_id: drive.drive_id, drive_name: 'Documents' }],
    fetch_delta: async (_tenant: string, _site: string, _drive: string, link?: string) =>
      drive.delta(link),
    // The failed-items list re-reads a failed file by id; answer with its live state.
    fetch_item_by_id: async (_tenant: string, _site: string, _drive: string, item_id: string) =>
      drive.delta().items.find((item) => item.item_id === item_id),
    download_file_content: async (item: { item_id: string; etag?: string }) =>
      Buffer.from(`${item.item_id}:${item.etag}`),
    list_file_versions: vi.fn(async () => VERSIONS),
    download_file_version: vi.fn(stub_drive_version_download()),
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
  const run = (force_full = false): Promise<SharePointBackupResult> =>
    service.backup_site('tenant-1', SITE, { force_full });
  const cursor = (): SharePointDeltaCursor | undefined => stores.saved_cursors.at(-1);
  const downloaded = (): string[] =>
    connector.download_file_version.mock.calls.map((call) => call[2]);
  return { drive, connector, run, cursor, downloaded };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SharePoint version capture after a failed run (issue #858)', () => {
  it('captures the versions on the rerun although the content deduplicates', async () => {
    const h = harness();
    h.drive.put_file('Report.docx');
    h.connector.list_file_versions.mockRejectedValueOnce(new Error('503 Service Unavailable'));

    const failed = await h.run();
    expect(failed.summary.healthy).toBe(false);
    expect(h.cursor()?.pending_versions_by_file_id).toEqual({ [FILE_ID]: {} });

    const rerun = await h.run();

    expect(rerun.summary.files_deduplicated).toBe(1);
    expect(h.downloaded().sort()).toEqual(['1.0', '2.0']);
    expect(h.cursor()?.version_watermark_by_file_id?.[FILE_ID]).toEqual(COMPLETE_WATERMARK);
    expect(h.cursor()?.pending_versions_by_file_id).toEqual({});
    expect(rerun.summary.healthy).toBe(true);
  });

  it('asks Graph nothing about the versions of a deduplicated file already captured', async () => {
    const h = harness();
    h.drive.put_file('Report.docx');
    await h.run();
    const listings = h.connector.list_file_versions.mock.calls.length;

    // A full read presents every file again, and every one deduplicates.
    const full = await h.run(true);

    expect(full.summary.files_deduplicated).toBe(1);
    expect(h.connector.list_file_versions).toHaveBeenCalledTimes(listings);
    expect(h.downloaded()).toHaveLength(2);
  });
});

describe('SharePoint "not found" on a listed version (issue #855)', () => {
  it('holds the watermark on a one-off 404 and captures the version on a later run', async () => {
    const h = harness();
    h.drive.put_file('Report.docx');
    h.connector.download_file_version.mockRejectedValueOnce(not_found());

    const first = await h.run();
    expect(first.summary.versions_unavailable).toBe(0);
    expect(first.summary.healthy).toBe(false);
    expect(h.cursor()?.version_watermark_by_file_id?.[FILE_ID]).toBeUndefined();

    h.drive.put_file('Report.docx');
    await h.run();

    // 2.0 comes again too: the held watermark covers neither, and storage deduplicates it.
    expect(h.downloaded()).toEqual(['1.0', '2.0', '1.0', '2.0']);
    expect(h.cursor()?.version_watermark_by_file_id?.[FILE_ID]).toEqual(COMPLETE_WATERMARK);
    expect(h.cursor()?.pending_versions_by_file_id).toEqual({});
  });

  it('accepts a version that keeps answering 404 after 3 runs spanning 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = harness();
    h.connector.download_file_version.mockImplementation(async (_d, _i, version_id, size) => {
      if (version_id === '1.0') throw not_found();
      return await stub_drive_version_download()(_d, _i, version_id, size);
    });

    const results: SharePointBackupResult[] = [];
    for (const hours of [0, 12, 25]) {
      vi.setSystemTime(new Date(T0.getTime() + hours * HOUR_MS));
      h.drive.put_file('Report.docx');
      results.push(await h.run());
    }

    expect(results.map((result) => result.summary.healthy)).toEqual([false, false, true]);
    expect(results[2]?.summary.versions_unavailable).toBe(1);
    expect(h.cursor()?.version_watermark_by_file_id?.[FILE_ID]).toEqual(COMPLETE_WATERMARK);
    expect(h.cursor()?.pending_versions_by_file_id).toEqual({});
  });
});
