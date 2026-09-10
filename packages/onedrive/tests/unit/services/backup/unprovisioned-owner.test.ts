/**
 * An owner whose OneDrive was never provisioned.
 *
 * Graph answers `GET /users/{id}/drives` with an empty list for one, and answers 403 for a
 * revoked grant, which the connector has already turned into the permission error. Reading empty
 * as a permission fault sent the operator to check a consent grant that was fine (issue #369).
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import type { OneDriveDrive, TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import { OneDriveBackupService } from '@/services/backup/backup.service';

interface Harness {
  service: OneDriveBackupService;
  manifest_save: Mock;
}

function make_harness(list_drives: () => Promise<OneDriveDrive[]>): Harness {
  const context = {
    tenant_id: 't',
    storage: {
      exists: vi.fn().mockResolvedValue(false),
      put: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      list_stale: vi.fn(async () => []),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    },
    encrypt: (buffer: Buffer) => buffer,
    destroy: vi.fn(),
  } as unknown as TenantContext;

  const factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(context),
    create_readonly: vi.fn().mockResolvedValue(context),
    create_storage_only: vi.fn(),
  };

  const manifest_save = vi.fn();
  const service = new OneDriveBackupService(
    factory,
    { list_drives: vi.fn(list_drives), fetch_delta: vi.fn(), list_file_versions: vi.fn() } as never,
    { save: manifest_save } as never,
    { load_version_watermarks: vi.fn().mockResolvedValue({}), write_run_index: vi.fn() } as never,
    { load: vi.fn().mockResolvedValue(undefined), save: vi.fn() } as never,
  );

  return { service, manifest_save };
}

describe('OneDrive backup for an owner with no drives', () => {
  it('completes as an empty run and writes no snapshot', async () => {
    const { service, manifest_save } = make_harness(async () => []);

    const result = await service.backup_onedrive('tenant-1', 'owner-1', {});

    expect(result.snapshot).toBeUndefined();
    expect(result.summary.snapshot_created).toBe(false);
    expect(result.summary.drives_scanned).toBe(0);
    expect(result.summary.files_stored).toBe(0);
    expect(result.summary.errors).toEqual([]);
    expect(result.summary.healthy).toBe(true);
    expect(manifest_save).not.toHaveBeenCalled();
  });

  it('still fails the run when the drives endpoint refuses', async () => {
    const { service } = make_harness(() => {
      throw new Error(
        'Missing Microsoft Graph application permissions for OneDrive: Files.Read.All.',
      );
    });

    await expect(service.backup_onedrive('tenant-1', 'owner-1', {})).rejects.toThrow(
      /Missing Microsoft Graph application permissions/,
    );
  });
});
