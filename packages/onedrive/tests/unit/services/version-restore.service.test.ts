import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apply_overrides, type Overrides } from '@wisecom/atlas-types/testing/apply-overrides';
import type {
  OneDriveConnector,
  OneDriveFileVersionIndex,
  OneDriveFileVersionIndexRepository,
  OneDriveFileVersionRecord,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { stub_encrypted_object_store } from '@wisecom/atlas-types/testing/stub-encrypted-object-store';
import { OneDriveVersionRestoreService } from '@/services/onedrive-version-restore.service';

const TENANT_ID = 'tenant-1';
const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const CUTOFF = new Date('2026-03-10T00:00:00Z');
const CONTENT = Buffer.from('pre-attack content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

function version(overrides: Overrides<OneDriveFileVersionRecord> = {}): OneDriveFileVersionRecord {
  return apply_overrides<OneDriveFileVersionRecord>(
    {
      snapshot_id: 'snap-1',
      backup_at: '2026-03-01T00:00:00.000Z',
      drive_id: 'drive-1',
      file_name: 'Report.docx',
      parent_path: '/Documents',
      size_bytes: CONTENT.length,
      storage_key: 'onedrive/data/owner/abc',
      checksum: CHECKSUM,
      change_type: 'updated',
      last_modified_at: '2026-03-01T08:15:00.000Z',
      version_id: '1.0',
    } as OneDriveFileVersionRecord,
    overrides,
  );
}

function make_mocks() {
  const ctx = {
    storage: { get: vi.fn().mockResolvedValue(Buffer.from('ciphertext')) },
    decrypt: vi.fn().mockReturnValue(CONTENT),
    destroy: vi.fn(),
  } as unknown as TenantContext;

  const tenant_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
    create_storage_only: vi.fn().mockResolvedValue(ctx),
  };

  const connector: OneDriveConnector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'OneDrive' }]),
    create_folder: vi.fn().mockResolvedValue('folder-1'),
    upload_small_file: vi.fn().mockResolvedValue(undefined),
    upload_large_file: vi.fn().mockResolvedValue(undefined),
  } as unknown as OneDriveConnector;

  const indexes: OneDriveFileVersionIndexRepository = {
    list_by_owner: vi.fn().mockResolvedValue([]),
  } as unknown as OneDriveFileVersionIndexRepository;

  return { ctx, tenant_factory, connector, indexes };
}

describe('OneDriveVersionRestoreService', () => {
  let service: OneDriveVersionRestoreService;
  let mocks: ReturnType<typeof make_mocks>;

  beforeEach(() => {
    mocks = make_mocks();
    service = new OneDriveVersionRestoreService(
      mocks.tenant_factory,
      mocks.connector,
      mocks.indexes,
    );
  });

  const given_versions = (...indexes: OneDriveFileVersionIndex[]): void => {
    vi.mocked(mocks.indexes.list_by_owner).mockResolvedValue(indexes);
  };

  const restore = (options: Parameters<typeof service.restore_onedrive_version>[2]) =>
    service.restore_onedrive_version(TENANT_ID, OWNER_ID, options);

  it('writes a sibling copy by default and never touches the live file', async () => {
    given_versions({ file_id: 'file-1', owner_id: OWNER_ID, versions: [version()] });

    const result = await restore({ file_ref: 'file-1', version_id: '1.0' });

    expect(result.files_restored).toBe(1);
    expect(result.placement).toBe('copy');
    const [call] = vi.mocked(mocks.connector.upload_small_file).mock.calls;
    expect(call?.[4]).toBe('Report (restored 2026-03-01T08-15-00Z).docx');
    // 'fail' rather than 'replace': a copy must never overwrite a real file.
    expect(call?.[6]).toBe('fail');
  });

  it('uploads over the original path only when in-place is asked for', async () => {
    given_versions({ file_id: 'file-1', owner_id: OWNER_ID, versions: [version()] });

    const result = await restore({
      file_ref: 'file-1',
      version_id: '1.0',
      placement: 'in-place',
    });

    const [call] = vi.mocked(mocks.connector.upload_small_file).mock.calls;
    expect(call?.[4]).toBe('Report.docx');
    // Microsoft 365 records this as a new version and keeps the poisoned one,
    // so nothing is destroyed even here.
    expect(call?.[6]).toBe('replace');
    expect(result.restored[0]?.restored_to).toBe('/Documents/Report.docx');
  });

  it('carries the version\u2019s own modification time to the upload', async () => {
    given_versions({ file_id: 'file-1', owner_id: OWNER_ID, versions: [version()] });

    await restore({ file_ref: 'file-1', version_id: '1.0' });

    // Issue #242: without this the restored file is stamped with the restore
    // time and looks authored during the incident.
    const [call] = vi.mocked(mocks.connector.upload_small_file).mock.calls;
    expect(call?.[7]).toEqual({ last_modified_at: '2026-03-01T08:15:00.000Z' });
  });

  it('restores to the drive the version was recorded in, without listing drives', async () => {
    given_versions({
      file_id: 'file-1',
      owner_id: OWNER_ID,
      versions: [version({ drive_id: 'drive-second' })],
    });

    await restore({ file_ref: 'file-1', version_id: '1.0' });

    const [call] = vi.mocked(mocks.connector.upload_small_file).mock.calls;
    expect(call?.[2]).toBe('drive-second');
    expect(mocks.connector.list_drives).not.toHaveBeenCalled();
  });

  it('skips a version whose stored bytes fail their checksum', async () => {
    given_versions({ file_id: 'file-1', owner_id: OWNER_ID, versions: [version()] });
    vi.mocked(mocks.ctx.decrypt).mockReturnValue(Buffer.from('tampered'));

    const result = await restore({ file_ref: 'file-1', version_id: '1.0' });

    expect(result.files_restored).toBe(0);
    expect(result.files_skipped).toBe(1);
    expect(result.errors[0]).toMatch(/could not be read or verified/);
    // Nothing may reach the live drive when the bytes cannot be trusted.
    expect(mocks.connector.upload_small_file).not.toHaveBeenCalled();
  });

  it('never calls Graph restoreVersion', async () => {
    given_versions({ file_id: 'file-1', owner_id: OWNER_ID, versions: [version()] });

    await restore({ file_ref: 'file-1', version_id: '1.0' });

    // The connector has no restoreVersion method by design: promoting a
    // service-side version cannot be checked against the manifest checksum,
    // and it is gone once history is trimmed.
    expect('restore_version' in mocks.connector).toBe(false);
  });

  it('rolls back every file in scope and reports those with no pre-cutoff version', async () => {
    given_versions(
      { file_id: 'file-1', owner_id: OWNER_ID, versions: [version()] },
      {
        file_id: 'file-2',
        owner_id: OWNER_ID,
        versions: [
          version({
            file_name: 'Later.docx',
            last_modified_at: '2026-03-20T00:00:00.000Z',
            version_id: '4.0',
          }),
        ],
      },
    );

    const result = await restore({ before: CUTOFF });

    expect(result.files_restored).toBe(1);
    expect(result.files_skipped).toBe(1);
    expect(result.errors[0]).toMatch(/Later\.docx: no stored version at or before the cutoff/);
  });

  it('uses the resumable upload path above the small-file limit', async () => {
    // Above 4 MB the blob is decrypted as a stream, so this needs a real
    // key-bound cipher rather than a decrypt() stub.
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    const big_checksum = createHash('sha256').update(big).digest('hex');
    const store = stub_encrypted_object_store();
    const stored = store.encrypt(big);
    const streaming_ctx = {
      storage: { get_stream: vi.fn(async () => store.stream(stored)) },
      create_decipher: store.create_decipher,
      destroy: vi.fn(),
    } as unknown as TenantContext;
    vi.mocked(mocks.tenant_factory.create).mockResolvedValue(streaming_ctx);
    given_versions({
      file_id: 'file-1',
      owner_id: OWNER_ID,
      versions: [version({ size_bytes: big.length, checksum: big_checksum })],
    });

    await restore({ file_ref: 'file-1', version_id: '1.0' });

    expect(mocks.connector.upload_large_file).toHaveBeenCalledTimes(1);
    expect(mocks.connector.upload_small_file).not.toHaveBeenCalled();
  });

  it('stops at an interrupt and reports the run as interrupted', async () => {
    given_versions(
      { file_id: 'file-1', owner_id: OWNER_ID, versions: [version()] },
      { file_id: 'file-2', owner_id: OWNER_ID, versions: [version({ file_name: 'B.docx' })] },
    );
    let uploaded = 0;
    vi.mocked(mocks.connector.upload_small_file).mockImplementation(async () => {
      uploaded++;
    });

    const result = await restore({ before: CUTOFF, should_interrupt: () => uploaded >= 1 });

    expect(uploaded).toBe(1);
    expect(result.interrupted).toBe(true);
  });

  it('destroys the tenant context on the success and the failure path', async () => {
    given_versions({ file_id: 'file-1', owner_id: OWNER_ID, versions: [version()] });
    await restore({ file_ref: 'file-1', version_id: '1.0' });
    expect(mocks.ctx.destroy).toHaveBeenCalledTimes(1);

    vi.mocked(mocks.indexes.list_by_owner).mockRejectedValue(new Error('index unreadable'));
    await expect(restore({ before: CUTOFF })).rejects.toThrow('index unreadable');
    expect(mocks.ctx.destroy).toHaveBeenCalledTimes(2);
  });

  it('normalises the owner id before reading the index', async () => {
    given_versions({ file_id: 'file-1', owner_id: OWNER_ID, versions: [version()] });

    await service.restore_onedrive_version(TENANT_ID, OWNER_ID.toUpperCase(), {
      file_ref: 'file-1',
      version_id: '1.0',
    });

    expect(mocks.indexes.list_by_owner).toHaveBeenCalledWith(expect.anything(), OWNER_ID);
  });
});
