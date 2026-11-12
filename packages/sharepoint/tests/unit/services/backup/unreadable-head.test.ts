/**
 * Issue #709: a drive run resumes from its delta cursor and read no manifest, so a damaged newest
 * manifest went unreported and the run exited 0, where Outlook names the object and exits 9.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SharePointDeltaCursor, SharePointSnapshotManifest } from '@wisecom/atlas-types';
import {
  make_connector,
  make_ctx,
  make_cursors,
  make_file_item,
  make_manifests,
  make_service,
} from './backup-determinism.fixtures';

const DAMAGED_KEY = 'sharepoint/manifests/site-1/sp-snap-9999-abc.json';
const OLDER_KEY = 'sharepoint/manifests/site-1/sp-snap-1.json';

const OLDER = {
  snapshot_id: 'sp-snap-1',
  created_at: new Date('2026-09-01T00:00:00Z'),
  entries: [],
} as unknown as SharePointSnapshotManifest;

/**
 * Saved by the run that wrote the damaged manifest. That manifest still exists, so the cursor is
 * resumed (#725) and the run is incremental.
 */
const CURSOR = {
  site_id: 'site-1',
  snapshot_id: 'sp-snap-9999-abc',
  delta_link_by_drive: { 'drive-1': 'link-1' },
  previous_path_by_file_id: { f1: '/Docs' },
  previous_name_by_file_id: { f1: 'f1.docx' },
  previous_etag_by_file_id: { f1: 'etag-old' },
  previous_kind_by_file_id: { f1: 'file' },
  updated_at: '2026-09-01T00:00:00Z',
} as unknown as SharePointDeltaCursor;

/** A tenant context whose listing holds the site's two manifests. */
function ctx_listing_both_manifests() {
  const ctx = make_ctx();
  vi.mocked(ctx.storage.list).mockImplementation(async (prefix: string) =>
    prefix.startsWith('sharepoint/manifests/') ? [OLDER_KEY, DAMAGED_KEY] : [],
  );
  return ctx;
}

/** A manifest repository whose newest manifest is damaged and whose older one reads. */
function manifests_with_damaged_head() {
  const manifests = make_manifests();
  vi.mocked(manifests.find_latest_readable).mockResolvedValue({
    manifest: OLDER,
    unreadable_keys: [DAMAGED_KEY],
  });
  return manifests;
}

function delta_with(items: ReturnType<typeof make_file_item>[]) {
  return make_connector({
    fetch_delta: vi.fn().mockResolvedValue({
      drive_id: 'drive-1',
      delta_link: 'link-2',
      items,
      reset_detected: false,
    }),
  });
}

describe('SharePoint backup when the newest manifest is unreadable (issue #709)', () => {
  it('names the damaged key on an incremental run and still writes its snapshot', async () => {
    const manifests = manifests_with_damaged_head();
    const cursors = make_cursors(CURSOR);

    const result = await make_service({
      connector: delta_with([make_file_item('f1')]),
      manifests,
      cursors,
      ctx: ctx_listing_both_manifests(),
    }).backup_site('tenant-1', 'site-1');

    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
    expect(result.snapshot?.entries.map((e) => e.file_id)).toEqual(['f1']);
    expect(manifests.save).toHaveBeenCalledTimes(1);
    expect(cursors.save).toHaveBeenCalledTimes(1);
    expect(manifests.list_readable_snapshots_by_site).not.toHaveBeenCalled();
  });

  it('names the damaged key on a run with no changes', async () => {
    const result = await make_service({
      connector: delta_with([]),
      manifests: manifests_with_damaged_head(),
      cursors: make_cursors(CURSOR),
      ctx: ctx_listing_both_manifests(),
    }).backup_site('tenant-1', 'site-1');

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.no_snapshot_reason).toBe('no_changes');
    expect(result.summary.unreadable_keys).toEqual([DAMAGED_KEY]);
  });

  it('checks the head before it saves its own manifest, which would hide the damaged one', async () => {
    const manifests = manifests_with_damaged_head();

    await make_service({
      connector: delta_with([make_file_item('f1')]),
      manifests,
      cursors: make_cursors(CURSOR),
      ctx: ctx_listing_both_manifests(),
    }).backup_site('tenant-1', 'site-1');

    const lookup = vi.mocked(manifests.find_latest_readable).mock.invocationCallOrder[0]!;
    const save = vi.mocked(manifests.save).mock.invocationCallOrder[0]!;
    expect(lookup).toBeLessThan(save);
  });

  it('reports nothing when the newest manifest reads cleanly', async () => {
    const result = await make_service({
      connector: delta_with([make_file_item('f1')]),
      cursors: make_cursors(CURSOR),
      ctx: ctx_listing_both_manifests(),
    }).backup_site('tenant-1', 'site-1');

    expect(result.summary.unreadable_keys).toBeUndefined();
  });
});
