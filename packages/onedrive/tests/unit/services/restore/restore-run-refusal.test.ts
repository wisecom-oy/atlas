/**
 * Issue #871: a refusal that applies to the whole drive, such as a missing write grant or a
 * revoked credential, failed every remaining file one by one and the restore exited 2. It now ends
 * the restore with the typed error, after the files restored before it, and sends nothing more.
 */
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  MissingGraphPermissionsError,
  type OneDriveConnector,
  type OneDriveManifestEntry,
  type OneDriveManifestRepository,
  type OneDriveSnapshotManifest,
  type TenantContext,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import { OneDriveRestoreService } from '@/services/restore/restore.service';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const CONTENT = Buffer.from('file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');
const FILE_IDS = ['file-1', 'file-2', 'file-3'];

function make_entry(file_id: string): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: `${file_id}.docx`,
    parent_path: '/Documents',
    size_bytes: CONTENT.length,
    change_type: 'updated',
    backup_at: '2026-08-17T00:00:00.000Z',
    storage_key: `onedrive/data/${file_id}`,
    checksum: CHECKSUM,
  } as OneDriveManifestEntry;
}

/** A restore of three files whose upload of `file-2` fails with `upload_failure`. */
function make_service(upload_failure?: () => unknown) {
  const entries = FILE_IDS.map(make_entry);
  const manifest = {
    snapshot_id: 'snap-1',
    owner_id: 'owner-1',
    created_at: new Date('2026-08-17T00:00:00.000Z'),
    total_files: entries.length,
    entries,
  } as unknown as OneDriveSnapshotManifest;
  const ctx = {
    tenant_id: 'tenant-1',
    storage: { get: vi.fn().mockResolvedValue(CONTENT) },
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
    destroy: vi.fn(),
  } as unknown as TenantContext;
  const factory = {
    create: vi.fn().mockResolvedValue(ctx),
    create_readonly: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory;
  const connector = {
    list_drives: vi.fn().mockResolvedValue([{ drive_id: 'drive-1', drive_name: 'Documents' }]),
    create_folder: vi.fn().mockResolvedValue('folder-1'),
    upload_small_file: vi.fn(async (...args: unknown[]) => {
      if (args[4] === 'file-2.docx' && upload_failure) throw upload_failure();
      return `item-${String(args[4])}`;
    }),
    upload_large_file: vi.fn(),
  } as unknown as OneDriveConnector;
  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_readable_snapshots_by_owner: vi.fn().mockResolvedValue(readable_manifests([])),
    ...drive_chain_reads('onedrive'),
  } as unknown as OneDriveManifestRepository;
  const leases = stub_owner_leases().leases;
  return { service: new OneDriveRestoreService(factory, connector, manifests, leases), connector };
}

/** File names the restore sent, in order. */
function uploaded_names(connector: OneDriveConnector): unknown[] {
  return vi.mocked(connector.upload_small_file).mock.calls.map((call) => call[4]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OneDrive restore refused for the whole drive (issue #871)', () => {
  it('ends with MissingGraphPermissionsError on a 403 accessDenied and sends nothing more', async () => {
    const { service, connector } = make_service(() => graph_error(403, 'accessDenied'));

    const run = service.restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' });

    await expect(run).rejects.toBeInstanceOf(MissingGraphPermissionsError);
    await expect(run).rejects.toMatchObject({
      code: 'ATLAS_AUTH_DENIED',
      permissions: ['Files.ReadWrite.All'],
      graph_code: 'accessDenied',
    });
    expect(uploaded_names(connector)).toEqual(['file-1.docx', 'file-2.docx']);
  });

  it('reports the files restored before the refusal', async () => {
    const { service } = make_service(() => graph_error(403, 'accessDenied'));

    await service
      .restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' })
      .catch(() => undefined);

    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^Restored: .*file-1\.docx$/));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('OneDrive restore stopped after 1 file(s) restored'),
    );
  });

  it('ends with the AuthError a refused credential raised', async () => {
    const refusal = new AuthError('Entra ID refused the client credentials');
    const { service, connector } = make_service(() => refusal);

    const run = service.restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' });

    await expect(run).rejects.toBe(refusal);
    expect(uploaded_names(connector)).toHaveLength(2);
  });

  it('ends on a refused folder create before any file is sent', async () => {
    const { service, connector } = make_service();
    vi.mocked(connector.create_folder).mockRejectedValue(graph_error(403, 'accessDenied'));

    const run = service.restore_onedrive('tenant-1', 'owner-1', { snapshot_id: 'snap-1' });

    await expect(run).rejects.toBeInstanceOf(MissingGraphPermissionsError);
    expect(connector.create_folder).toHaveBeenCalledTimes(1);
    expect(connector.upload_small_file).not.toHaveBeenCalled();
  });

  it.each([
    ['a 400 on one file', () => graph_error(400, 'invalidRequest')],
    ['a 403 whose code names no missing grant', () => graph_error(403, 'notAllowed')],
  ])('fails only that file on %s', async (_label, failure) => {
    const { service, connector } = make_service(failure);

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
    });

    expect(uploaded_names(connector)).toHaveLength(3);
    expect(result.files_restored).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^file-2\.docx: /);
  });

  it('reports a cancellation as an interrupt, not as the refusal', async () => {
    const controller = new AbortController();
    const { service } = make_service(() => {
      controller.abort(new Error('Run interrupted by Ctrl+C'));
      return new AuthError('refused while the run was stopping');
    });

    const result = await service.restore_onedrive('tenant-1', 'owner-1', {
      snapshot_id: 'snap-1',
      abort_signal: controller.signal,
    });

    expect(result.interrupted).toBe(true);
    expect(result.files_restored).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
