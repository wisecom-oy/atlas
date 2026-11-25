import { describe, it, expect, vi } from 'vitest';
import type { SharePointDeltaItem } from '@wisecom/atlas-types';
import {
  make_connector,
  make_cursors,
  make_file_indexes,
  make_file_item,
  make_manifests,
  make_service,
} from './backup-determinism.fixtures';

// Issue #92: version downloads that fail for an unexpected reason left history
// out of the snapshot while the run reported HEALTHY and exited 0.

function make_delta(items: SharePointDeltaItem[]) {
  return vi.fn().mockResolvedValue({
    drive_id: 'drive-1',
    delta_link: 'https://delta-link',
    items,
    reset_detected: false,
  });
}

const LISTED = [{ version_id: '1.0', last_modified_at: '2026-01-01', size_bytes: 10 }];

function run_backup(version_error: unknown, relisted = LISTED) {
  const connector = make_connector({
    fetch_delta: make_delta([make_file_item('f1')]),
    list_file_versions: vi.fn().mockResolvedValueOnce(LISTED).mockResolvedValue(relisted),
    download_file_version: vi.fn().mockRejectedValue(version_error),
  });

  return make_service({
    connector,
    manifests: make_manifests(),
    file_indexes: make_file_indexes(),
    cursors: make_cursors(),
  }).backup_site('tenant-1', 'site-1', {});
}

describe('SharePoint backup — version download failures (issue #92)', () => {
  it('reports an unexpected version failure as an error and marks the run unhealthy', async () => {
    const result = await run_backup({ statusCode: 403, code: 'accessDenied', message: '' });

    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toContain('1 version download(s) failed unexpectedly');
    expect(result.summary.healthy).toBe(false);
  });

  it('keeps an expired version (410) out of the error bucket and stays healthy', async () => {
    // Expired: the version has left the list by the time the run reads it again (issue #855).
    const result = await run_backup({ statusCode: 410 }, []);

    expect(result.summary.errors).toEqual([]);
    expect(result.summary.versions_unavailable).toBe(1);
    expect(result.summary.healthy).toBe(true);
  });

  it('reports a 404 on a version that is still listed as an error (issue #855)', async () => {
    const result = await run_backup({ statusCode: 404 });

    expect(result.summary.errors[0]).toContain('1 version download(s) failed unexpectedly');
    expect(result.summary.versions_unavailable).toBe(0);
    expect(result.summary.healthy).toBe(false);
  });
});
