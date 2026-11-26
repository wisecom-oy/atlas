/**
 * Issue #871: a refusal that applies to the whole site, such as a missing write grant or a
 * revoked credential, failed every remaining file one by one and the restore exited 2. It now ends
 * the restore with the typed error, after the files restored before it, and sends nothing more.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { graph_error } from '@wisecom/atlas-types/testing/stub-graph-client';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  MissingGraphPermissionsError,
  type SharePointManifestEntry,
  type SharePointManifestRepository,
  type SharePointSiteConnector,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import { SharePointRestoreService } from '@/services/restore/restore.service';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CONTENT = Buffer.from('restored-file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');
const FILE_IDS = ['file-1', 'file-2', 'file-3'];

function make_entry(file_id: string): SharePointManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    library_name: 'Documents',
    file_name: `${file_id}.docx`,
    parent_path: '/Reports',
    size_bytes: CONTENT.length,
    change_type: 'created',
    backup_at: '2026-08-17T00:00:00.000Z',
    storage_key: `sharepoint/data/site-1/${file_id}`,
    checksum: CHECKSUM,
  };
}

/** A restore of three files whose upload of `file-2` fails with `upload_failure`. */
function make_harness(upload_failure?: () => unknown) {
  const entries = FILE_IDS.map(make_entry);
  const store = in_memory_tenant_context('tenant-1');
  for (const entry of entries) {
    store.set_raw(entry.storage_key!, store.ctx.encrypt(CONTENT, entry.storage_key!));
  }
  const factory = {
    create: vi.fn(async () => store.ctx),
    create_readonly: vi.fn(async () => store.ctx),
    create_storage_only: vi.fn(),
  } as unknown as TenantContextFactory;
  const connector = {
    list_document_libraries: vi.fn().mockResolvedValue([]),
    create_folder: vi.fn().mockResolvedValue('folder-1'),
    upload_small_file: vi.fn(async (...args: unknown[]) => {
      if (args[4] === 'file-2.docx' && upload_failure) throw upload_failure();
      return `item-${String(args[4])}`;
    }),
    upload_large_file: vi.fn(),
  } as unknown as SharePointSiteConnector;
  const manifests = {
    find_by_snapshot: vi.fn().mockResolvedValue({
      snapshot_id: 'sp-snap-1',
      site_id: 'site-1',
      created_at: new Date('2026-08-17T00:00:00.000Z'),
      total_files: entries.length,
      entries,
    }),
    list_readable_snapshots_by_site: vi.fn().mockResolvedValue(readable_manifests([])),
    ...drive_chain_reads('sharepoint'),
  } as unknown as SharePointManifestRepository;
  const leases = stub_owner_leases().leases;
  return {
    connector,
    service: new SharePointRestoreService(factory, connector, manifests, leases),
  };
}

/** File names the restore sent, in order. */
function uploaded_names(connector: SharePointSiteConnector): unknown[] {
  return vi.mocked(connector.upload_small_file).mock.calls.map((call) => call[4]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SharePoint restore refused for the whole site (issue #871)', () => {
  it('ends with MissingGraphPermissionsError on a 403 accessDenied and sends nothing more', async () => {
    const { service, connector } = make_harness(() => graph_error(403, 'accessDenied'));

    const run = service.restore_sharepoint('tenant-1', 'site-1', { snapshot_id: 'sp-snap-1' });

    await expect(run).rejects.toBeInstanceOf(MissingGraphPermissionsError);
    await expect(run).rejects.toMatchObject({
      code: 'ATLAS_AUTH_DENIED',
      permissions: ['Sites.ReadWrite.All'],
      graph_code: 'accessDenied',
    });
    expect(uploaded_names(connector)).toEqual(['file-1.docx', 'file-2.docx']);
  });

  it('reports the files restored before the refusal', async () => {
    const { service } = make_harness(() => graph_error(403, 'accessDenied'));

    await service
      .restore_sharepoint('tenant-1', 'site-1', { snapshot_id: 'sp-snap-1' })
      .catch(() => undefined);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/^Restored: .*file-1\.docx \(drive: drive-1\)$/),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('SharePoint restore stopped after 1 file(s) restored'),
    );
  });

  it('ends with the AuthError a refused credential raised', async () => {
    const refusal = new AuthError('Entra ID refused the client credentials');
    const { service, connector } = make_harness(() => refusal);

    const run = service.restore_sharepoint('tenant-1', 'site-1', { snapshot_id: 'sp-snap-1' });

    await expect(run).rejects.toBe(refusal);
    expect(uploaded_names(connector)).toHaveLength(2);
  });

  it('ends on a refused folder create before any file is sent', async () => {
    const { service, connector } = make_harness();
    vi.mocked(connector.create_folder).mockRejectedValue(graph_error(403, 'accessDenied'));

    const run = service.restore_sharepoint('tenant-1', 'site-1', { snapshot_id: 'sp-snap-1' });

    await expect(run).rejects.toBeInstanceOf(MissingGraphPermissionsError);
    expect(connector.create_folder).toHaveBeenCalledTimes(1);
    expect(connector.upload_small_file).not.toHaveBeenCalled();
  });

  it.each([
    ['a 400 on one file', () => graph_error(400, 'invalidRequest')],
    ['a 403 whose code names no missing grant', () => graph_error(403, 'notAllowed')],
  ])('fails only that file on %s', async (_label, failure) => {
    const { service, connector } = make_harness(failure);

    const result = await service.restore_sharepoint('tenant-1', 'site-1', {
      snapshot_id: 'sp-snap-1',
    });

    expect(uploaded_names(connector)).toHaveLength(3);
    expect(result.files_restored).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^file-2\.docx: /);
  });

  it('reports a cancellation as an interrupt, not as the refusal', async () => {
    const controller = new AbortController();
    const { service } = make_harness(() => {
      controller.abort(new Error('Run interrupted by Ctrl+C'));
      return new AuthError('refused while the run was stopping');
    });

    const result = await service.restore_sharepoint('tenant-1', 'site-1', {
      snapshot_id: 'sp-snap-1',
      abort_signal: controller.signal,
    });

    expect(result.interrupted).toBe(true);
    expect(result.files_restored).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
