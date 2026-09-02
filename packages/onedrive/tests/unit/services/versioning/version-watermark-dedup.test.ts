import { describe, it, expect, vi, type Mock } from 'vitest';
import type {
  OneDriveDeltaCursor,
  OneDriveDeltaItem,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveBackupService } from '@/services/backup/backup.service';

// Issue #161: version dedup used to preload the whole version index on every
// run, which is one GET per backup ever taken for the owner. It now rides on
// the delta cursor, so a steady-state run reads no index objects at all.

const FILE: OneDriveDeltaItem = {
  item_id: 'f1',
  drive_id: 'd1',
  kind: 'file',
  file_name: 'report.docx',
  parent_path: '/Documents',
  size_bytes: 64,
  etag: 'etag-f1',
  deleted: false,
  download_url: 'https://example.invalid/f1',
};

const VERSIONS = [
  { version_id: '2.0', last_modified_at: '2026-02-01T00:00:00Z', size_bytes: 20 },
  { version_id: '1.0', last_modified_at: '2026-01-01T00:00:00Z', size_bytes: 10 },
];

const COMPLETE_WATERMARK = {
  last_modified_at: '2026-02-01T00:00:00Z',
  version_ids: ['2.0'],
};

/**
 * `failing_extra_item` makes a second delta item throw out of the item loop,
 * which costs the drive its accumulated entries: the run then finalizes with
 * no snapshot while still holding the version rows captured before the throw.
 */
function make_harness(
  stored_cursor: OneDriveDeltaCursor | undefined,
  options: { failing_extra_item?: boolean } = {},
) {
  const items: OneDriveDeltaItem[] = options.failing_extra_item
    ? [FILE, { ...FILE, item_id: 'f2', file_name: 'broken.docx', etag: 'etag-f2' }]
    : [FILE];
  const context = {
    tenant_id: 't',
    storage: {
      list: vi.fn().mockResolvedValue([]),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
    },
    encrypt: (data: Buffer) => data,
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(context),
    create_readonly: vi.fn().mockResolvedValue(context),
    create_storage_only: vi.fn(),
  };
  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'd1', drive_name: 'OneDrive' }]),
    fetch_delta: vi.fn().mockResolvedValue({
      drive_id: 'd1',
      delta_link: 'link-1',
      items,
      reset_detected: false,
    }),
    download_file_content: vi.fn().mockResolvedValue(Buffer.from('content')),
    list_file_versions: vi.fn(async (_drive_id: string, item_id: string) => {
      if (item_id === 'f2') throw new Error('graph failed mid-drive');
      return VERSIONS;
    }),
    download_file_version: vi.fn().mockResolvedValue(Buffer.from('old-content')),
  };
  const file_indexes = {
    load_version_watermarks: vi.fn().mockResolvedValue({}),
    write_run_index: vi.fn(),
  };
  const cursors = {
    load: vi.fn().mockResolvedValue(stored_cursor),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const service = new OneDriveBackupService(
    factory,
    connector as never,
    { save: vi.fn().mockResolvedValue(undefined) } as never,
    file_indexes as never,
    cursors as never,
  );
  return { service, connector, file_indexes, cursors };
}

function make_cursor(
  watermarks: OneDriveDeltaCursor['version_watermark_by_file_id'],
): OneDriveDeltaCursor {
  return {
    owner_id: 'owner-1',
    delta_link_by_drive: { d1: 'link-0' },
    previous_path_by_file_id: {},
    previous_name_by_file_id: {},
    previous_etag_by_file_id: {},
    previous_kind_by_file_id: {},
    ...(watermarks !== undefined ? { version_watermark_by_file_id: watermarks } : {}),
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/** The cursor the run persisted, whichever finalize path saved it. */
function saved_cursor(cursors: { save: Mock }): OneDriveDeltaCursor {
  return cursors.save.mock.calls.at(-1)?.[1] as OneDriveDeltaCursor;
}

describe('OneDrive version dedup watermarks (issue #161)', () => {
  it('reads no index objects when the cursor already carries watermarks', async () => {
    const { service, file_indexes, connector } = make_harness(
      make_cursor({ f1: COMPLETE_WATERMARK }),
    );

    await service.backup_onedrive('t', 'owner-1', {});

    expect(file_indexes.load_version_watermarks).not.toHaveBeenCalled();
    expect(connector.download_file_version).not.toHaveBeenCalled();
  });

  it('seeds watermarks from the index once when upgrading a cursor without them', async () => {
    const { service, file_indexes } = make_harness(make_cursor(undefined));

    await service.backup_onedrive('t', 'owner-1', {});

    expect(file_indexes.load_version_watermarks).toHaveBeenCalledTimes(1);
  });

  it('persists the advanced watermark so the next run skips those versions', async () => {
    const { service, cursors } = make_harness(make_cursor({}));

    await service.backup_onedrive('t', 'owner-1', {});

    expect(saved_cursor(cursors).version_watermark_by_file_id).toEqual({
      f1: COMPLETE_WATERMARK,
    });
  });

  it('keeps watermarks across a forced full run, which only resets the delta link', async () => {
    const { service, file_indexes, connector } = make_harness(
      make_cursor({ f1: COMPLETE_WATERMARK }),
    );

    await service.backup_onedrive('t', 'owner-1', { force_full: true });

    // A forced full re-reads every file from Graph, but re-downloading version
    // history Atlas already holds is pure waste.
    expect(file_indexes.load_version_watermarks).not.toHaveBeenCalled();
    expect(connector.download_file_version).not.toHaveBeenCalled();
  });

  it('indexes captured versions before the watermark cursor when the run keeps no entries', async () => {
    const { service, file_indexes, cursors } = make_harness(make_cursor({}), {
      failing_extra_item: true,
    });

    const result = await service.backup_onedrive('t', 'owner-1', {});

    expect(result.summary.snapshot_created).toBe(false);
    const indexes = file_indexes.write_run_index.mock.calls.at(-1)?.[3] as Array<{
      file_id: string;
      versions: Array<{ version_id?: string }>;
    }>;
    expect(indexes.flatMap((idx) => idx.versions.map((v) => v.version_id))).toEqual(
      expect.arrayContaining(['1.0', '2.0']),
    );
    // The watermark that makes the next run skip those versions must never be
    // durable before the rows describing them.
    expect(saved_cursor(cursors).version_watermark_by_file_id).toEqual({
      f1: COMPLETE_WATERMARK,
    });
    expect(file_indexes.write_run_index.mock.invocationCallOrder[0]).toBeLessThan(
      cursors.save.mock.invocationCallOrder.at(-1) as number,
    );
  });
});
