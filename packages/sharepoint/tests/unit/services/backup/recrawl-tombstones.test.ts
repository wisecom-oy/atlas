/**
 * Issue #435: a full enumeration of a library lists what exists, not what was removed, so a file
 * deleted since the last run must be tombstoned by comparing the enumeration with the previous chain.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  SharePointDeltaCursor,
  SharePointDeltaItem,
  SharePointManifestEntry,
  SharePointSiteConnector,
  SharePointSnapshotManifest,
} from '@wisecom/atlas-types';
import {
  make_connector,
  make_cursors,
  make_file_item,
  make_manifests,
  make_service,
} from './backup-determinism.fixtures';

function stored_entry(file_id: string, drive_id = 'drive-1'): SharePointManifestEntry {
  return {
    file_id,
    drive_id,
    library_name: 'Documents',
    file_name: `${file_id}.docx`,
    parent_path: '/Docs',
    size_bytes: 512,
    storage_key: `sharepoint/data/site-1/${file_id}`,
    checksum: 'c'.repeat(64),
    backup_at: '2026-09-01T00:00:00.000Z',
    change_type: 'created',
  };
}

const PREVIOUS = {
  snapshot_id: 'sp-snap-1',
  created_at: new Date('2026-09-01T00:00:00Z'),
  entries: [stored_entry('report'), stored_entry('budget'), stored_entry('slides', 'drive-2')],
} as unknown as SharePointSnapshotManifest;

const CURSOR: SharePointDeltaCursor = {
  site_id: 'site-1',
  delta_link_by_drive: { 'drive-1': 'link-1', 'drive-2': 'link-2' },
  previous_path_by_file_id: {},
  previous_name_by_file_id: {},
  previous_etag_by_file_id: {},
  previous_kind_by_file_id: {},
  updated_at: '2026-09-01T00:00:00Z',
} as unknown as SharePointDeltaCursor;

interface Libraries {
  readonly connector: SharePointSiteConnector;
  readonly should_interrupt: () => boolean;
}

function two_libraries(
  drive_1: { items: SharePointDeltaItem[]; reset_detected?: boolean },
  options: { stop_after_first_download?: boolean } = {},
): Libraries {
  let downloads = 0;
  const connector = make_connector({
    list_document_libraries: vi.fn().mockResolvedValue([
      { drive_id: 'drive-1', drive_name: 'Documents' },
      { drive_id: 'drive-2', drive_name: 'Slides' },
    ]),
    fetch_delta: vi.fn(async (_t: string, _s: string, drive_id: string) => ({
      drive_id,
      delta_link: `next-${drive_id}`,
      items: drive_id === 'drive-1' ? drive_1.items : [],
      reset_detected: drive_id === 'drive-1' && drive_1.reset_detected === true,
    })),
    download_file_content: vi.fn(async () => {
      downloads++;
      return Buffer.from('data');
    }),
  });
  return {
    connector,
    should_interrupt: () => options.stop_after_first_download === true && downloads > 0,
  };
}

async function tombstoned_after(libraries: Libraries, force_full: boolean): Promise<string[]> {
  const manifests = make_manifests();
  vi.mocked(manifests.list_snapshots_by_site).mockResolvedValue([PREVIOUS]);
  const result = await make_service({
    connector: libraries.connector,
    manifests,
    cursors: make_cursors(CURSOR),
  }).backup_site('tenant-1', 'site-1', {
    force_full,
    should_interrupt: libraries.should_interrupt,
  });
  return (result.snapshot?.entries ?? [])
    .filter((entry) => entry.change_type === 'deleted')
    .map((entry) => entry.file_id);
}

describe('SharePoint re-crawl tombstones (issue #435)', () => {
  it('tombstones a file a --full enumeration no longer lists', async () => {
    const libraries = two_libraries({ items: [make_file_item('report')] });

    // drive-2 is re-crawled too and returns nothing, so its file is gone as well.
    expect(await tombstoned_after(libraries, true)).toEqual(['budget', 'slides']);
  });

  it('tombstones only in the library whose delta reset, never a sibling library', async () => {
    const libraries = two_libraries({ items: [make_file_item('report')], reset_detected: true });

    expect(await tombstoned_after(libraries, false)).toEqual(['budget']);
  });

  it('writes no tombstone on an incremental delta', async () => {
    const libraries = two_libraries({ items: [make_file_item('report')] });

    expect(await tombstoned_after(libraries, false)).toEqual([]);
  });

  it('writes no tombstone when the run stops before the library finishes', async () => {
    const libraries = two_libraries(
      { items: [make_file_item('report'), make_file_item('other')], reset_detected: true },
      { stop_after_first_download: true },
    );

    expect(await tombstoned_after(libraries, false)).toEqual([]);
  });
});
