/**
 * Issue #405: a site with nothing in it and a site already covered by a snapshot both returned
 * `snapshot: undefined`, `files_stored: 0`, `files_deduplicated: 0`, `healthy: true`, `errors: []`.
 * A consumer branching on that shape reported an empty site as backed up while no recovery point
 * existed for it, which is the one thing a backup product must not get wrong.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SharePointDeltaCursor, SharePointSnapshotManifest } from '@wisecom/atlas-types';
import {
  make_connector,
  make_cursors,
  make_file_indexes,
  make_file_item,
  make_manifests,
  make_service,
} from './backup-determinism.fixtures';

/** A cursor from an earlier run that knows the site holds one file. */
function cursor_knowing_a_file(): SharePointDeltaCursor {
  return {
    site_id: 'site-1',
    delta_link_by_drive: { 'drive-1': 'https://delta-link' },
    previous_path_by_file_id: { f1: '/Documents/Report.docx' },
    previous_name_by_file_id: { f1: 'Report.docx' },
    previous_etag_by_file_id: { f1: 'etag-1' },
    previous_kind_by_file_id: { f1: 'file' },
    updated_at: new Date().toISOString(),
  };
}

describe('SharePoint backup with no snapshot to create (issue #405)', () => {
  it('reports no_content when the site holds nothing and no snapshot exists', async () => {
    const result = await make_service({
      connector: make_connector({ list_document_libraries: vi.fn().mockResolvedValue([]) }),
    }).backup_site('tenant-1', 'site-1');

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.no_snapshot_reason).toBe('no_content');
  });

  it('reports no_changes when the cursor already knows a file', async () => {
    const result = await make_service({
      cursors: make_cursors(cursor_knowing_a_file()),
    }).backup_site('tenant-1', 'site-1');

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.no_snapshot_reason).toBe('no_changes');
  });

  it('reports no_changes for an empty-looking run that has a snapshot in storage', async () => {
    // A cursor written before the kind map existed, or one whose files were all pruned from the
    // manifest by retention, still has a recovery point. Calling that no_content would raise a
    // false alarm about an unprotected site.
    const manifests = make_manifests();
    vi.mocked(manifests.find_latest_by_site).mockResolvedValue({
      snapshot_id: 'sp-snap-1',
    } as SharePointSnapshotManifest);

    const result = await make_service({
      manifests,
      connector: make_connector({ list_document_libraries: vi.fn().mockResolvedValue([]) }),
    }).backup_site('tenant-1', 'site-1');

    expect(result.summary.no_snapshot_reason).toBe('no_changes');
  });

  it('does not spend a manifest lookup when the cursor already proves content', async () => {
    const manifests = make_manifests();

    await make_service({ manifests, cursors: make_cursors(cursor_knowing_a_file()) }).backup_site(
      'tenant-1',
      'site-1',
    );

    expect(manifests.find_latest_by_site).not.toHaveBeenCalled();
  });

  it('leaves the reason unset when every processed item failed', async () => {
    // A failed item still counts as processed, so the run walked something and stored nothing.
    // Calling that `no_changes` would report a site as covered whose changes never landed.
    const connector = make_connector({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'https://delta-link',
        items: [make_file_item('f1')],
        reset_detected: false,
      }),
      download_file_content: vi.fn().mockRejectedValue(new Error('download failed')),
    });

    const result = await make_service({ connector }).backup_site('tenant-1', 'site-1');

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.healthy).toBe(false);
    expect(result.summary.no_snapshot_reason).toBeUndefined();
  });

  it('leaves the reason unset when a snapshot was created', async () => {
    const connector = make_connector({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'https://delta-link',
        items: [make_file_item('f1')],
        reset_detected: false,
      }),
    });

    const result = await make_service({ connector, file_indexes: make_file_indexes() }).backup_site(
      'tenant-1',
      'site-1',
    );

    expect(result.summary.snapshot_created).toBe(true);
    expect(result.summary.no_snapshot_reason).toBeUndefined();
  });
});
