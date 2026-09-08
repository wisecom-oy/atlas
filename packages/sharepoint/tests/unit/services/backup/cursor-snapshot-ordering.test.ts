import { describe, expect, it, vi } from 'vitest';
import type { SharePointDeltaCursor, SharePointManifestRepository } from '@wisecom/atlas-types';
import {
  make_connector,
  make_cursors,
  make_file_indexes,
  make_file_item,
  make_manifests,
  make_service,
} from './backup-determinism.fixtures';

// Issue #339: change tracking must never be committed ahead of the snapshot
// that makes the scanned content reachable. A manifest write that fails after
// the cursor was saved orphans the ciphertext and the next run sees no work.

function make_delta(delta_link: string) {
  return vi.fn().mockResolvedValue({
    drive_id: 'drive-1',
    delta_link,
    items: [make_file_item('f1')],
    reset_detected: false,
  });
}

function make_failing_manifests(): SharePointManifestRepository {
  const manifests = make_manifests();
  vi.mocked(manifests.save).mockRejectedValue(new Error('manifest write failed'));
  return manifests;
}

describe('SharePoint backup cursor and snapshot ordering (issue #339)', () => {
  it('saves the cursor last, after the manifest and the run version index', async () => {
    const order: string[] = [];
    const cursors = make_cursors();
    const manifests = make_manifests();
    const file_indexes = make_file_indexes();
    vi.mocked(cursors.save).mockImplementation(() => {
      order.push('cursor');
      return Promise.resolve();
    });
    vi.mocked(manifests.save).mockImplementation(() => {
      order.push('manifest');
      return Promise.resolve();
    });
    vi.mocked(file_indexes.write_run_index).mockImplementation(() => {
      order.push('index');
      return Promise.resolve();
    });
    const connector = make_connector({ fetch_delta: make_delta('https://next') });

    await make_service({ connector, manifests, cursors, file_indexes }).backup_site(
      'tenant-1',
      'site-1',
    );

    expect(order).toEqual(['manifest', 'index', 'cursor']);
  });

  it('leaves the cursor untouched when the version index write fails', async () => {
    // The index carries the version rows the cursor's watermarks tell the next run to skip, so a
    // cursor written past a failed index write makes that history unreachable.
    const cursors = make_cursors();
    const file_indexes = make_file_indexes();
    vi.mocked(file_indexes.write_run_index).mockRejectedValue(new Error('index write failed'));
    const connector = make_connector({ fetch_delta: make_delta('https://next') });

    await expect(
      make_service({
        connector,
        manifests: make_manifests(),
        cursors,
        file_indexes,
      }).backup_site('tenant-1', 'site-1'),
    ).rejects.toThrow('index write failed');

    expect(cursors.save).not.toHaveBeenCalled();
  });

  it('leaves the cursor untouched when the manifest write fails', async () => {
    const cursors = make_cursors();
    const connector = make_connector({ fetch_delta: make_delta('https://next') });

    await expect(
      make_service({
        connector,
        manifests: make_failing_manifests(),
        cursors,
        file_indexes: make_file_indexes(),
      }).backup_site('tenant-1', 'site-1'),
    ).rejects.toThrow('manifest write failed');

    expect(cursors.save).not.toHaveBeenCalled();
  });

  it('recovers the file on the next run after a failed manifest write', async () => {
    const cursors = make_cursors();
    const connector = make_connector({ fetch_delta: make_delta('https://next') });
    await make_service({
      connector,
      manifests: make_failing_manifests(),
      cursors,
      file_indexes: make_file_indexes(),
    })
      .backup_site('tenant-1', 'site-1')
      .catch(() => undefined);

    // The retry loads whatever run 1 committed, which must still be nothing.
    const saved = vi.mocked(cursors.save).mock.calls.at(-1)?.[1] as
      SharePointDeltaCursor | undefined;
    const retry_cursors = make_cursors(saved);
    const retry = await make_service({
      connector: make_connector({ fetch_delta: make_delta('https://next') }),
      manifests: make_manifests(),
      cursors: retry_cursors,
      file_indexes: make_file_indexes(),
    }).backup_site('tenant-1', 'site-1');

    expect(retry.snapshot?.entries.map((entry) => entry.file_id)).toEqual(['f1']);
    expect(retry.summary.healthy).toBe(true);
  });
});
