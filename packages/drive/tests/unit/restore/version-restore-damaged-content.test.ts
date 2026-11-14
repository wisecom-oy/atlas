/**
 * Issue #712, which reverses #633. Version restore shares the snapshot restore policy: a stored
 * version that is damaged fails only its own file, and the rollback goes on. A data key that does
 * not unwrap still stops the run before any version is read.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { describe, expect, it, vi } from 'vitest';
import { WrongPassphraseError, type TenantContext } from '@wisecom/atlas-types';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import type { DriveFileVersionIndexView, DriveFileVersionRecord } from '@/drive-ports';
import { DAMAGED_OBJECT_REASON } from '@/restore/restore-content-read';
import { restore_drive_version, type DriveVersionRestoreDeps } from '@/restore/version-restore';
import { readable_indexes } from '@wisecom/atlas-types/testing/readable-listing';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CUTOFF = new Date('2026-03-10T00:00:00Z');

function index(file_id: string): DriveFileVersionIndexView {
  const version = {
    snapshot_id: 'snap-1',
    backup_at: '2026-03-01T00:00:00.000Z',
    drive_id: 'drive-1',
    file_name: `${file_id}.docx`,
    parent_path: '/Documents',
    size_bytes: 7,
    storage_key: `onedrive/data/owner-1/${file_id}`,
    checksum: 'abc',
    change_type: 'updated',
    last_modified_at: '2026-03-01T00:00:00.000Z',
    version_id: '1.0',
  } as DriveFileVersionRecord;
  return { file_id, versions: [version] };
}

/** Version restore deps where the stored objects of the named files are damaged. */
function make_deps(damaged: readonly string[]) {
  const ctx = { destroy: vi.fn() } as unknown as TenantContext;
  const connector = {
    upload_small_file: vi.fn().mockResolvedValue(undefined),
    upload_large_file: vi.fn().mockResolvedValue(undefined),
  };
  const deps: DriveVersionRestoreDeps = {
    workload: 'onedrive',
    tenant_factory: {
      create_readonly: vi.fn().mockResolvedValue(ctx),
    } as unknown as TenantContextFactory,
    leases: stub_owner_leases().leases,
    connector,
    list_indexes: vi.fn().mockResolvedValue(readable_indexes([index('file-1'), index('file-2')])),
    download_blob: vi.fn(async (_ctx: TenantContext, version: DriveFileVersionRecord) =>
      damaged.includes(version.file_name)
        ? ({ kind: 'unrestorable', reason: DAMAGED_OBJECT_REASON } as const)
        : ({ kind: 'readable', content: Buffer.from('content') } as const),
    ),
    ensure_folder_path: vi.fn().mockResolvedValue('folder-1'),
  };
  return { ctx, connector, deps };
}

describe('restore_drive_version past a damaged stored version (issue #712)', () => {
  it('restores the other version and names the damaged file', async () => {
    const { ctx, connector, deps } = make_deps(['file-1.docx']);

    const result = await restore_drive_version(deps, 'tenant-1', 'owner-1', { before: CUTOFF });

    expect(deps.download_blob).toHaveBeenCalledTimes(2);
    expect(connector.upload_small_file).toHaveBeenCalledTimes(1);
    expect(result.files_restored).toBe(1);
    expect(result.files_skipped).toBe(1);
    expect(result.errors).toEqual([`/Documents/file-1.docx: ${DAMAGED_OBJECT_REASON}`]);
    expect(ctx.destroy).toHaveBeenCalledTimes(1);
  });

  it('stops with the wrong-passphrase error before reading when the key does not unwrap', async () => {
    const { connector, deps } = make_deps([]);
    vi.mocked(deps.tenant_factory.create_readonly).mockRejectedValueOnce(
      new WrongPassphraseError('Could not unwrap the data key'),
    );

    const restore = restore_drive_version(deps, 'tenant-1', 'owner-1', { before: CUTOFF });

    await expect(restore).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(deps.download_blob).not.toHaveBeenCalled();
    expect(connector.upload_small_file).not.toHaveBeenCalled();
  });

  it('still reports any other per-version failure as a skip', async () => {
    const { deps } = make_deps([]);
    vi.mocked(deps.ensure_folder_path).mockRejectedValueOnce(new Error('HTTP 503'));

    const result = await restore_drive_version(deps, 'tenant-1', 'owner-1', { before: CUTOFF });

    expect(result.files_restored).toBe(1);
    expect(result.files_skipped).toBe(1);
    expect(result.errors[0]).toContain('HTTP 503');
  });
});
