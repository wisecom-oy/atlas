import { describe, it, expect, vi } from 'vitest';
import type {
  OneDriveBackupResult,
  OneDriveDeltaItem,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveBackupService } from '@/services/onedrive-backup.service';

// Issue #92: version downloads that fail for an unexpected reason left history
// out of the snapshot while the run reported HEALTHY and exited 0.

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

function run_backup(version_error: unknown): Promise<OneDriveBackupResult> {
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
    list_file_versions: vi
      .fn()
      .mockResolvedValue([{ version_id: '1.0', last_modified_at: '2026-01-01', size_bytes: 10 }]),
    download_file_version: vi.fn().mockRejectedValue(version_error),
  };

  const service = new OneDriveBackupService(
    factory,
    connector as never,
    { save: vi.fn().mockResolvedValue(undefined) } as never,
    {
      find_by_file_id: vi.fn().mockResolvedValue(undefined),
      append_version: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      load: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    } as never,
  );
  return service.backup_onedrive('t', 'owner-1', {});
}

describe('OneDrive backup — version download failures (issue #92)', () => {
  it('reports an unexpected version failure as an error and marks the run unhealthy', async () => {
    const result = await run_backup({ statusCode: 403, code: 'accessDenied', message: '' });

    expect(result.summary.errors).toHaveLength(1);
    expect(result.summary.errors[0]).toContain('1 version download(s) failed unexpectedly');
    expect(result.summary.healthy).toBe(false);
  });

  it('keeps an expired version (410) out of the error bucket and stays healthy', async () => {
    const result = await run_backup({ statusCode: 410 });

    expect(result.summary.errors).toEqual([]);
    expect(result.summary.versions_unavailable).toBe(1);
    expect(result.summary.healthy).toBe(true);
  });
});
