import { describe, it, expect, vi, type Mock } from 'vitest';
import type { SharePointDeltaCursor } from '@wisecom/atlas-types';
import {
  make_connector,
  make_cursors,
  make_file_indexes,
  make_file_item,
  make_service,
} from './sharepoint-backup-determinism.fixtures';

// Issue #161: version dedup used to preload the whole version index on every
// run, which is one GET per backup ever taken for the site. It now rides on
// the delta cursor, so a steady-state run reads no index objects at all.

const VERSIONS = [
  { version_id: '2.0', last_modified_at: '2026-02-01T00:00:00Z', size_bytes: 20 },
  { version_id: '1.0', last_modified_at: '2026-01-01T00:00:00Z', size_bytes: 10 },
];

function make_cursor(watermarks: Record<string, string> | undefined): SharePointDeltaCursor {
  return {
    site_id: 'site-1',
    delta_link_by_drive: { 'drive-1': 'https://delta-link-0' },
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    ...(watermarks !== undefined ? { version_watermark_by_file_id: watermarks } : {}),
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/**
 * `failing_scan_cursor_save` makes the per-library cursor save throw, which
 * costs the library its accumulated entries: the run then finalizes with no
 * snapshot while still holding the version rows captured before the throw.
 */
function make_harness(
  stored_cursor: SharePointDeltaCursor | undefined,
  options: { failing_scan_cursor_save?: boolean } = {},
) {
  const connector = make_connector({
    fetch_delta: vi.fn().mockResolvedValue({
      drive_id: 'drive-1',
      delta_link: 'https://delta-link',
      items: [make_file_item('f1')],
      reset_detected: false,
    }),
    list_file_versions: vi.fn().mockResolvedValue(VERSIONS),
    download_file_version: vi.fn().mockResolvedValue(Buffer.from('old-content')),
  } as never);
  const file_indexes = make_file_indexes();
  const cursors = make_cursors(stored_cursor);
  if (options.failing_scan_cursor_save) {
    (cursors.save as unknown as Mock).mockRejectedValueOnce(new Error('cursor save failed'));
  }
  return {
    service: make_service({ connector, file_indexes, cursors }),
    connector,
    file_indexes,
    cursors,
  };
}

/** The cursor the run persisted, whichever finalize path saved it. */
function saved_cursor(cursors: { save: unknown }): SharePointDeltaCursor {
  const save = cursors.save as ReturnType<typeof vi.fn>;
  return save.mock.calls.at(-1)?.[1] as SharePointDeltaCursor;
}

describe('SharePoint version dedup watermarks (issue #161)', () => {
  it('reads no index objects when the cursor already carries watermarks', async () => {
    const { service, file_indexes, connector } = make_harness(
      make_cursor({ f1: '2026-02-01T00:00:00Z' }),
    );

    await service.backup_site('tenant-1', 'site-1', {});

    expect(file_indexes.load_version_watermarks).not.toHaveBeenCalled();
    expect(connector.download_file_version).not.toHaveBeenCalled();
  });

  it('seeds watermarks from the index once when upgrading a cursor without them', async () => {
    const { service, file_indexes } = make_harness(make_cursor(undefined));

    await service.backup_site('tenant-1', 'site-1', {});

    expect(file_indexes.load_version_watermarks).toHaveBeenCalledTimes(1);
  });

  it('persists the advanced watermark so the next run skips those versions', async () => {
    const { service, cursors } = make_harness(make_cursor({}));

    await service.backup_site('tenant-1', 'site-1', {});

    expect(saved_cursor(cursors).version_watermark_by_file_id).toEqual({
      f1: '2026-02-01T00:00:00Z',
    });
  });

  it('keeps watermarks across a forced full run, which only resets the delta link', async () => {
    const { service, file_indexes, connector } = make_harness(
      make_cursor({ f1: '2026-02-01T00:00:00Z' }),
    );

    await service.backup_site('tenant-1', 'site-1', { force_full: true });

    // A forced full re-reads every file from Graph, but re-downloading version
    // history Atlas already holds is pure waste.
    expect(file_indexes.load_version_watermarks).not.toHaveBeenCalled();
    expect(connector.download_file_version).not.toHaveBeenCalled();
  });

  it('indexes captured versions before the watermark cursor when the run keeps no entries', async () => {
    const { service, file_indexes, cursors } = make_harness(make_cursor({}), {
      failing_scan_cursor_save: true,
    });

    const result = await service.backup_site('tenant-1', 'site-1', {});

    expect(result.summary.snapshot_created).toBe(false);
    const write_run_index = file_indexes.write_run_index as unknown as Mock;
    const indexes = write_run_index.mock.calls.at(-1)?.[3] as Array<{
      versions: Array<{ version_id?: string }>;
    }>;
    expect(indexes.flatMap((idx) => idx.versions.map((v) => v.version_id))).toEqual(
      expect.arrayContaining(['1.0', '2.0']),
    );
    // The watermark that makes the next run skip those versions must never be
    // durable before the rows describing them.
    expect(saved_cursor(cursors).version_watermark_by_file_id).toEqual({
      f1: '2026-02-01T00:00:00Z',
    });
    const save = cursors.save as unknown as Mock;
    expect(write_run_index.mock.invocationCallOrder[0]).toBeLessThan(
      save.mock.invocationCallOrder.at(-1) as number,
    );
  });
});
