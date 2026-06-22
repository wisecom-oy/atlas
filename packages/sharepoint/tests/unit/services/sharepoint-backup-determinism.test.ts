import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SharePointSiteConnector,
  SharePointDeltaCursorRepository,
  SharePointFileVersionIndexRepository,
  SharePointManifestRepository,
} from '@wisecom/atlas-types';
import {
  make_connector,
  make_cursors,
  make_file_indexes,
  make_file_item,
  make_manifests,
  make_service,
} from './sharepoint-backup-determinism.fixtures';

describe('SharePoint backup determinism — error isolation', () => {
  let connector: SharePointSiteConnector;
  let manifests: SharePointManifestRepository;
  let file_indexes: SharePointFileVersionIndexRepository;
  let cursors: SharePointDeltaCursorRepository;

  beforeEach(() => {
    connector = make_connector();
    manifests = make_manifests();
    file_indexes = make_file_indexes();
    cursors = make_cursors();
  });

  it('discards ALL library entries when a single file fails to process', async () => {
    const good_file = make_file_item('good-1');
    const bad_file = make_file_item('bad-1');

    connector = make_connector({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'https://delta-link',
        items: [good_file, bad_file],
        reset_detected: false,
      }),
      download_file_content: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from('good-content'))
        .mockResolvedValueOnce(undefined as unknown as Buffer),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors.length).toBeGreaterThan(0);
    expect(result.snapshot).toBeUndefined();
    expect(result.summary.files_stored).toBe(0);
    expect(result.summary.files_changed).toBe(0);
    expect(manifests.save).not.toHaveBeenCalled();
  });

  it('does NOT update delta cursor for a library with errors', async () => {
    connector = make_connector({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'https://new-delta-link',
        items: [make_file_item('f1')],
        reset_detected: false,
      }),
      download_file_content: vi.fn().mockRejectedValue(new Error('network failure')),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(false);

    const cursor_save_calls = (cursors.save as ReturnType<typeof vi.fn>).mock.calls;
    for (const [, saved_cursor] of cursor_save_calls) {
      expect(saved_cursor.delta_link_by_drive).not.toHaveProperty('drive-1');
    }
  });

  it('marks result as UNHEALTHY when a library-level exception occurs', async () => {
    connector = make_connector({
      fetch_delta: vi.fn().mockRejectedValue(new Error('Graph API 503')),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Graph API 503')]),
    );
    expect(result.snapshot).toBeUndefined();
    expect(manifests.save).not.toHaveBeenCalled();
  });

  it('does NOT persist version indexes for files in a failed library', async () => {
    connector = make_connector({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'https://delta-link',
        items: [make_file_item('f1'), make_file_item('f2')],
        reset_detected: false,
      }),
      download_file_content: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from('data'))
        .mockResolvedValueOnce(undefined as unknown as Buffer),
      list_file_versions: vi.fn().mockResolvedValue([]),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    await service.backup_site('tenant-1', 'site-1');

    expect(manifests.save).not.toHaveBeenCalled();

    const append_calls = (file_indexes.append_version as ReturnType<typeof vi.fn>).mock.calls;
    const appended_file_ids = append_calls.map((c: unknown[]) => c[2]);
    expect(appended_file_ids).not.toContain('f1');
    expect(appended_file_ids).not.toContain('f2');
  });

  it('isolates errors per library — a healthy library is NOT contaminated by a failed one', async () => {
    connector = make_connector({
      list_document_libraries: vi.fn().mockResolvedValue([
        { drive_id: 'drive-good', drive_name: 'Good Lib' },
        { drive_id: 'drive-bad', drive_name: 'Bad Lib' },
      ]),
      fetch_delta: vi.fn().mockImplementation((_t: string, _s: string, drive_id: string) => {
        if (drive_id === 'drive-good') {
          return Promise.resolve({
            drive_id: 'drive-good',
            delta_link: 'https://good-delta',
            items: [make_file_item('g1', { drive_id: 'drive-good' })],
            reset_detected: false,
          });
        }
        return Promise.reject(new Error('Bad library exploded'));
      }),
      download_file_content: vi.fn().mockResolvedValue(Buffer.from('good-data')),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.errors.length).toBe(1);
    expect(result.summary.errors[0]).toContain('Bad Lib');

    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.entries).toHaveLength(1);
    expect(result.snapshot!.entries[0].file_id).toBe('g1');
    expect(result.summary.files_stored).toBe(1);

    const cursor_save_calls = (cursors.save as ReturnType<typeof vi.fn>).mock.calls;
    const last_cursor = cursor_save_calls[cursor_save_calls.length - 1][1];
    expect(last_cursor.delta_link_by_drive).toHaveProperty('drive-good');
    expect(last_cursor.delta_link_by_drive).not.toHaveProperty('drive-bad');
  });

  it('a fully successful backup is HEALTHY with snapshot and cursor updated', async () => {
    connector = make_connector({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'https://good-delta',
        items: [make_file_item('f1'), make_file_item('f2')],
        reset_detected: false,
      }),
      download_file_content: vi.fn().mockResolvedValue(Buffer.from('content')),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(true);
    expect(result.summary.errors).toHaveLength(0);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.entries).toHaveLength(2);
    expect(result.summary.files_stored).toBe(2);
    expect(result.summary.snapshot_created).toBe(true);
    expect(result.summary.cursor_updated).toBe(true);

    expect(manifests.save).toHaveBeenCalledTimes(1);
    expect(cursors.save).toHaveBeenCalled();

    const last_cursor = (cursors.save as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(last_cursor.delta_link_by_drive['drive-1']).toBe('https://good-delta');
  });

  it('no snapshot is created when the only library fails', async () => {
    connector = make_connector({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'https://delta-link',
        items: [make_file_item('f1')],
        reset_detected: false,
      }),
      download_file_content: vi.fn().mockImplementation(() => {
        throw new Error('download exploded');
      }),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(false);
    expect(result.snapshot).toBeUndefined();
    expect(result.summary.snapshot_created).toBe(false);
    expect(manifests.save).not.toHaveBeenCalled();
  });

  it('files_stored count is zero when all files fail', async () => {
    connector = make_connector({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'https://delta-link',
        items: [make_file_item('f1'), make_file_item('f2'), make_file_item('f3')],
        reset_detected: false,
      }),
      download_file_content: vi
        .fn()
        .mockResolvedValueOnce(Buffer.from('ok'))
        .mockResolvedValueOnce(undefined as unknown as Buffer)
        .mockResolvedValueOnce(Buffer.from('ok')),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(false);
    expect(result.summary.files_stored).toBe(0);
    expect(result.summary.files_changed).toBe(0);
  });

  it('no changes detected produces HEALTHY result with no snapshot', async () => {
    connector = make_connector({
      fetch_delta: vi.fn().mockResolvedValue({
        drive_id: 'drive-1',
        delta_link: 'https://delta-link',
        items: [],
        reset_detected: false,
      }),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.summary.healthy).toBe(true);
    expect(result.summary.errors).toHaveLength(0);
    expect(result.snapshot).toBeUndefined();
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.files_stored).toBe(0);
    expect(result.summary.files_changed).toBe(0);
    expect(manifests.save).not.toHaveBeenCalled();
    expect(cursors.save).toHaveBeenCalled();
  });
});
