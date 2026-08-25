import { describe, it, expect, vi } from 'vitest';
import type {
  OneDriveDeltaCursor,
  OneDriveDeltaItem,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveBackupService } from '@/services/onedrive-backup.service';

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

function make_harness(stored_cursor: OneDriveDeltaCursor | undefined) {
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
      items: [FILE],
      reset_detected: false,
    }),
    download_file_content: vi.fn().mockResolvedValue(Buffer.from('content')),
    list_file_versions: vi.fn().mockResolvedValue(VERSIONS),
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

function make_cursor(watermarks: Record<string, string> | undefined): OneDriveDeltaCursor {
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
function saved_cursor(cursors: { save: ReturnType<typeof vi.fn> }): OneDriveDeltaCursor {
  const last = cursors.save.mock.calls.at(-1);
  return last?.[1] as OneDriveDeltaCursor;
}

describe('OneDrive version dedup watermarks (issue #161)', () => {
  it('reads no index objects when the cursor already carries watermarks', async () => {
    const { service, file_indexes, connector } = make_harness(
      make_cursor({ f1: '2026-02-01T00:00:00Z' }),
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
      f1: '2026-02-01T00:00:00Z',
    });
  });

  it('keeps watermarks across a forced full run, which only resets the delta link', async () => {
    const { service, file_indexes, connector } = make_harness(
      make_cursor({ f1: '2026-02-01T00:00:00Z' }),
    );

    await service.backup_onedrive('t', 'owner-1', { force_full: true });

    // A forced full re-reads every file from Graph, but re-downloading version
    // history Atlas already holds is pure waste.
    expect(file_indexes.load_version_watermarks).not.toHaveBeenCalled();
    expect(connector.download_file_version).not.toHaveBeenCalled();
  });
});
