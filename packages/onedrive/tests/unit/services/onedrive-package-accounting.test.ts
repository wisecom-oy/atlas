import { describe, expect, it, vi } from 'vitest';
import type {
  OneDriveBackupResult,
  OneDriveDeltaItem,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveBackupService } from '@/services/onedrive-backup.service';

// Issue #52: a OneNote notebook root arrives as a folder carrying the `package`
// facet and its sections arrive as ordinary files. Nothing downloads from the
// root, so the run must at least account for the notebook and say when it came
// through incomplete.

const NOTEBOOK_ROOT: OneDriveDeltaItem = {
  item_id: 'nb-root',
  drive_id: 'd1',
  kind: 'folder',
  file_name: 'Team Notebook',
  parent_path: '/Documents',
  package_type: 'oneNote',
  size_bytes: 0,
  deleted: false,
};

function make_section(item_id: string, file_name: string): OneDriveDeltaItem {
  return {
    item_id,
    drive_id: 'd1',
    kind: 'file',
    file_name,
    parent_path: '/Documents/Team Notebook',
    size_bytes: 64,
    etag: `etag-${item_id}`,
    deleted: false,
    download_url: `https://example.invalid/${item_id}`,
  };
}

function run_backup(
  items: OneDriveDeltaItem[],
  failing_item_ids: readonly string[] = [],
): Promise<OneDriveBackupResult> {
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
    fetch_delta: vi
      .fn()
      .mockResolvedValue({ drive_id: 'd1', delta_link: 'link-1', items, reset_detected: false }),
    download_file_content: vi.fn(async (item: OneDriveDeltaItem) => {
      if (failing_item_ids.includes(item.item_id)) throw new Error('403 forbidden');
      return Buffer.from(item.item_id);
    }),
    list_file_versions: vi.fn().mockResolvedValue([]),
  };
  const manifests = { save: vi.fn().mockResolvedValue(undefined) };
  const file_indexes = {
    find_by_file_id: vi.fn().mockResolvedValue(undefined),
    append_version: vi.fn().mockResolvedValue(undefined),
  };
  const cursors = {
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
  };

  const service = new OneDriveBackupService(
    factory,
    connector as never,
    manifests as never,
    file_indexes as never,
    cursors as never,
  );
  return service.backup_onedrive('t', 'owner-1', {});
}

describe('OneNote package accounting (issue #52)', () => {
  it('reports a detected notebook and its section files', async () => {
    const result = await run_backup([
      NOTEBOOK_ROOT,
      make_section('sec-1', 'Section A.one'),
      make_section('sec-2', 'Section B.one'),
    ]);

    expect(result.summary.warnings).toContain(
      'OneNote notebooks detected: 1 (2 section file(s) backed up as ordinary files).',
    );
  });

  it('flags the notebook as INCOMPLETE when a section file fails to download', async () => {
    const result = await run_backup(
      [
        NOTEBOOK_ROOT,
        make_section('sec-1', 'Section A.one'),
        make_section('sec-2', 'Section B.one'),
      ],
      ['sec-2'],
    );

    const incomplete = result.summary.warnings.filter((w) => w.includes('INCOMPLETE'));
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain('Team Notebook');
    expect(incomplete[0]).toContain('Section B.one');
    expect(result.summary.warnings).toContain(
      'OneNote notebooks detected: 1 (1 section file(s) backed up as ordinary files).',
    );
  });

  it('stays silent when the delta batch holds no package items', async () => {
    const result = await run_backup([
      { ...make_section('f-1', 'Report.docx'), parent_path: '/Documents' },
    ]);

    expect(result.summary.warnings.filter((w) => w.includes('OneNote'))).toEqual([]);
  });
});
