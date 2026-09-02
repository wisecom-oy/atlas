import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  SharePointDeltaItem,
  SharePointFileVersionIndexRepository,
  SharePointManifestRepository,
} from '@wisecom/atlas-types';
import type { FailedItemLedger } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { MAX_FAILED_ITEM_ATTEMPTS } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  make_connector,
  make_cursors,
  make_file_indexes,
  make_file_item,
  make_manifests,
  make_service,
} from './backup-determinism.fixtures';

function make_delta(items: SharePointDeltaItem[], delta_link: string) {
  return vi.fn().mockResolvedValue({
    drive_id: 'drive-1',
    delta_link,
    items,
    reset_detected: false,
  });
}

function make_failed_record(item_id: string, attempts: number) {
  return {
    item_id,
    drive_id: 'drive-1',
    name: `${item_id}.docx`,
    reason: 'file content could not be downloaded',
    attempts,
    first_failed_at: '2026-01-01T00:00:00.000Z',
    last_failed_at: '2026-01-02T00:00:00.000Z',
  };
}

function make_previous_cursor(failed_items: FailedItemLedger): SharePointDeltaCursor {
  return {
    site_id: 'site-1',
    delta_link_by_drive: { 'drive-1': 'https://old-delta-link' },
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    failed_items,
    updated_at: '2026-01-02T00:00:00.000Z',
  };
}

function last_saved_cursor(cursors: SharePointDeltaCursorRepository): SharePointDeltaCursor {
  const calls = vi.mocked(cursors.save).mock.calls;
  return calls[calls.length - 1]![1] as SharePointDeltaCursor;
}

/** Downloads succeed except for the named items, which resolve no content. */
function make_download(...poison_ids: string[]) {
  return vi.fn((item: SharePointDeltaItem) =>
    poison_ids.includes(item.item_id)
      ? Promise.resolve(undefined as unknown as Buffer)
      : Promise.resolve(Buffer.from(`content-${item.item_id}`)),
  );
}

describe('SharePoint backup — persistently failing items', () => {
  let manifests: SharePointManifestRepository;
  let file_indexes: SharePointFileVersionIndexRepository;

  beforeEach(() => {
    manifests = make_manifests();
    file_indexes = make_file_indexes();
  });

  it('keeps healthy files and advances the delta link past a poison file', async () => {
    const cursors = make_cursors();
    const connector = make_connector({
      fetch_delta: make_delta(
        [make_file_item('f1'), make_file_item('poison'), make_file_item('f2')],
        'https://new-delta-link',
      ),
      download_file_content: make_download('poison'),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.snapshot!.entries.map((e) => e.file_id)).toEqual(['f1', 'f2']);
    expect(last_saved_cursor(cursors).delta_link_by_drive['drive-1']).toBe(
      'https://new-delta-link',
    );
  });

  it('records the poison file in the saved cursor with one attempt', async () => {
    const cursors = make_cursors();
    const connector = make_connector({
      fetch_delta: make_delta([make_file_item('f1'), make_file_item('poison')], 'https://next'),
      download_file_content: make_download('poison'),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    const saved = last_saved_cursor(cursors);
    expect(Object.keys(saved.failed_items ?? {})).toEqual(['poison']);
    expect(saved.failed_items!['poison']).toMatchObject({
      item_id: 'poison',
      drive_id: 'drive-1',
      name: 'poison.docx',
      attempts: 1,
    });
    expect(result.summary.healthy).toBe(false);
  });

  it('re-fetches a recorded item before new delta items and clears it on success', async () => {
    const call_order: string[] = [];
    const cursors = make_cursors(make_previous_cursor({ poison: make_failed_record('poison', 1) }));
    const connector = make_connector({
      fetch_delta: make_delta([make_file_item('fresh')], 'https://next'),
      fetch_item_by_id: vi.fn((_t: string, _s: string, _d: string, item_id: string) => {
        call_order.push(`fetch:${item_id}`);
        return Promise.resolve(make_file_item(item_id));
      }),
      download_file_content: vi.fn((item: SharePointDeltaItem) => {
        call_order.push(`download:${item.item_id}`);
        return Promise.resolve(Buffer.from('content'));
      }),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(connector.fetch_item_by_id).toHaveBeenCalledWith(
      'tenant-1',
      'site-1',
      'drive-1',
      'poison',
    );
    expect(call_order).toEqual(['fetch:poison', 'download:poison', 'download:fresh']);
    expect(last_saved_cursor(cursors).failed_items).toEqual({});
    expect(result.snapshot!.entries.map((e) => e.file_id)).toEqual(['poison', 'fresh']);
    expect(result.summary.healthy).toBe(true);
  });

  it('clears a recorded item that no longer exists without reporting an error', async () => {
    const cursors = make_cursors(make_previous_cursor({ gone: make_failed_record('gone', 2) }));
    const connector = make_connector({
      fetch_delta: make_delta([], 'https://next'),
      fetch_item_by_id: vi.fn().mockResolvedValue(undefined),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(connector.fetch_item_by_id).toHaveBeenCalledTimes(1);
    expect(last_saved_cursor(cursors).failed_items).toEqual({});
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.warnings).toEqual([]);
    expect(result.summary.healthy).toBe(true);
  });

  it('stops re-fetching an exhausted item but keeps reporting it', async () => {
    const cursors = make_cursors(
      make_previous_cursor({ doomed: make_failed_record('doomed', MAX_FAILED_ITEM_ATTEMPTS) }),
    );
    const connector = make_connector({
      fetch_delta: make_delta([make_file_item('fresh')], 'https://next'),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(connector.fetch_item_by_id).not.toHaveBeenCalled();
    expect(result.summary.warnings).toEqual([
      expect.stringContaining('PERMANENTLY SKIPPED after 5 attempts'),
    ]);
    expect(result.summary.healthy).toBe(false);
    expect(last_saved_cursor(cursors).failed_items!['doomed'].attempts).toBe(
      MAX_FAILED_ITEM_ATTEMPTS,
    );
  });

  it('increments attempts when a retried item fails again', async () => {
    const cursors = make_cursors(make_previous_cursor({ poison: make_failed_record('poison', 1) }));
    const connector = make_connector({
      fetch_delta: make_delta([], 'https://next'),
      fetch_item_by_id: vi.fn().mockResolvedValue(make_file_item('poison')),
      download_file_content: make_download('poison'),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(last_saved_cursor(cursors).failed_items!['poison'].attempts).toBe(2);
    expect(result.summary.warnings).toEqual([
      expect.stringContaining('will retry (attempt 2 of 5)'),
    ]);
  });

  it('records an item whose processing throws instead of failing the library', async () => {
    const cursors = make_cursors();
    const connector = make_connector({
      fetch_delta: make_delta([make_file_item('f1'), make_file_item('boom')], 'https://next'),
      list_file_versions: vi.fn((_drive_id: string, item_id: string) =>
        item_id === 'boom'
          ? Promise.reject(new Error('version listing exploded'))
          : Promise.resolve([]),
      ),
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1');

    expect(result.snapshot!.entries.map((e) => e.file_id)).toEqual(['f1']);
    expect(last_saved_cursor(cursors).failed_items!['boom']).toMatchObject({
      attempts: 1,
      reason: 'version listing exploded',
    });
    expect(result.summary.errors).toEqual([]);
    expect(last_saved_cursor(cursors).delta_link_by_drive['drive-1']).toBe('https://next');
  });
  it('keeps the prior delta link when interrupted between items', async () => {
    let interrupted = false;
    const cursors = make_cursors(make_previous_cursor({}));
    const connector = make_connector({
      fetch_delta: make_delta([make_file_item('f1'), make_file_item('f2')], 'https://next'),
    });
    const on_progress = vi.fn((event: { phase: string; processed: number }) => {
      if (event.phase === 'processing' && event.processed === 1) interrupted = true;
    });

    const service = make_service({ connector, manifests, file_indexes, cursors });
    const result = await service.backup_site('tenant-1', 'site-1', {
      on_progress,
      should_interrupt: () => interrupted,
    });

    expect(result.interrupted).toBe(true);
    expect(result.snapshot!.entries.map((entry) => entry.file_id)).toEqual(['f1']);
    expect(last_saved_cursor(cursors).delta_link_by_drive['drive-1']).toBe(
      'https://old-delta-link',
    );
    expect(connector.download_file_content).toHaveBeenCalledTimes(1);
  });
  it('keeps the prior delta link when the last item callback cancels', async () => {
    let interrupted = false;
    const cursors = make_cursors(make_previous_cursor({}));
    const connector = make_connector({
      fetch_delta: make_delta([make_file_item('f1')], 'https://next'),
    });
    const service = make_service({ connector, manifests, file_indexes, cursors });

    const result = await service.backup_site('tenant-1', 'site-1', {
      on_progress: (event) => {
        if (event.phase === 'processing' && event.processed === 1) interrupted = true;
      },
      should_interrupt: () => interrupted,
    });

    expect(result.interrupted).toBe(true);
    expect(last_saved_cursor(cursors).delta_link_by_drive['drive-1']).toBe(
      'https://old-delta-link',
    );
  });
});
