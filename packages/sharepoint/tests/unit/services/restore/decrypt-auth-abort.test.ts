/**
 * Issue #633. An object that failed AES-GCM authentication was recorded as a per-file error and
 * the restore moved on, so a key that did not fit the snapshot produced N skipped files and a
 * partial summary. The first failed tag now aborts the restore as a key error.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  WrongPassphraseError,
  type SharePointManifestEntry,
  type SharePointManifestRepository,
  type SharePointSiteConnector,
  type TenantContextFactory,
} from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { SharePointRestoreService } from '@/services/restore/restore.service';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';

vi.mock('@wisecom/atlas-core/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CONTENT = Buffer.from('restored-file-content');
const CHECKSUM = createHash('sha256').update(CONTENT).digest('hex');

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

/** A restore over two stored files, the named ones with a flipped ciphertext byte. */
function make_harness(damaged: readonly string[]) {
  const entries = [make_entry('file-1'), make_entry('file-2')];
  const store = in_memory_tenant_context('tenant-1');
  for (const entry of entries) {
    const sealed = store.ctx.encrypt(CONTENT, entry.storage_key!);
    if (damaged.includes(entry.file_id)) sealed[sealed.length - 1]! ^= 0xff;
    store.set_raw(entry.storage_key!, sealed);
  }

  const factory = {
    create: vi.fn().mockResolvedValue(store.ctx),
    create_readonly: vi.fn().mockResolvedValue(store.ctx),
    create_storage_only: vi.fn(),
  } as unknown as TenantContextFactory;
  const connector = {
    list_document_libraries: vi.fn().mockResolvedValue([]),
    create_folder: vi.fn().mockResolvedValue('folder-1'),
    upload_small_file: vi.fn().mockResolvedValue(undefined),
    upload_large_file: vi.fn().mockResolvedValue(undefined),
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
  } as unknown as SharePointManifestRepository;

  return { store, connector, service: new SharePointRestoreService(factory, connector, manifests) };
}

describe('SharePoint restore after a decrypt authentication failure', () => {
  it('aborts with a key error before attempting the next file', async () => {
    const { store, connector, service } = make_harness(['file-1']);

    const restore = service.restore_sharepoint('tenant-1', 'site-1', { snapshot_id: 'sp-snap-1' });

    await expect(restore).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(restore).rejects.toMatchObject({ code: 'ATLAS_WRONG_PASSPHRASE' });
    await expect(restore).rejects.toThrow(/AES-GCM authentication failed for file-1\.docx/);
    expect(connector.upload_small_file).not.toHaveBeenCalled();
    expect(store.destroyed()).toBe(1);
  });

  it('restores every file when every tag authenticates', async () => {
    const { connector, service } = make_harness([]);

    const result = await service.restore_sharepoint('tenant-1', 'site-1', {
      snapshot_id: 'sp-snap-1',
    });

    expect(result.files_restored).toBe(2);
    expect(result.errors).toEqual([]);
    expect(connector.upload_small_file).toHaveBeenCalledTimes(2);
  });
});
