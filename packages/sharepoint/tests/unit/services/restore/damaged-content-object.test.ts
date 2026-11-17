/**
 * Issue #712, which reverses #633. A content object that failed AES-GCM authentication aborted the
 * whole restore as a wrong passphrase, so one damaged object stopped every file after it. The data
 * key and the manifests already proved the key, so a damaged object now fails only its own file.
 * A key that does not unwrap still stops the run before anything is written.
 */
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
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
const FILE_IDS = ['file-1', 'file-2', 'file-3'];

/** How the stored object of `file-2` is damaged. */
type Damage = 'none' | 'flipped-byte' | 'other-content' | 'missing';

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

/** Stores every file's object, then damages the middle one as asked. */
function store_objects(entries: SharePointManifestEntry[], damage: Damage) {
  const store = in_memory_tenant_context('tenant-1');
  for (const entry of entries) {
    const damaged = entry.file_id === 'file-2';
    if (damaged && damage === 'missing') continue;
    const plaintext = damaged && damage === 'other-content' ? Buffer.from('other') : CONTENT;
    const sealed = store.ctx.encrypt(plaintext, entry.storage_key!);
    if (damaged && damage === 'flipped-byte') sealed[sealed.length - 1]! ^= 0xff;
    store.set_raw(entry.storage_key!, sealed);
  }
  return store;
}

function make_harness(damage: Damage, open_context?: () => Promise<unknown>) {
  const entries = FILE_IDS.map(make_entry);
  const store = store_objects(entries, damage);

  const open = open_context ?? (async () => store.ctx);
  const factory = {
    create: vi.fn(open),
    create_readonly: vi.fn(open),
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
    ...drive_chain_reads('sharepoint'),
  } as unknown as SharePointManifestRepository;

  return {
    store,
    connector,
    service: new SharePointRestoreService(
      factory,
      connector,
      manifests,
      stub_owner_leases().leases,
    ),
  };
}

/** File names the restore uploaded, in order. */
function uploaded_names(connector: SharePointSiteConnector): string[] {
  return vi.mocked(connector.upload_small_file).mock.calls.map((call) => call[4]);
}

describe('SharePoint restore past one damaged content object (issue #712)', () => {
  it.each([
    ['fails AES-GCM authentication', 'flipped-byte', /AES-GCM authentication/],
    ['decrypts to other content', 'other-content', /SHA-256 checksum/],
    ['is missing from storage', 'missing', /stored object is missing/],
  ] as const)('restores the other files when one object %s', async (_label, damage, reason) => {
    const { store, connector, service } = make_harness(damage);

    const result = await service.restore_sharepoint('tenant-1', 'site-1', {
      snapshot_id: 'sp-snap-1',
    });

    expect(uploaded_names(connector)).toEqual(['file-1.docx', 'file-3.docx']);
    expect(result.files_restored).toBe(2);
    expect(result.files_skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^file-2\.docx: /);
    expect(result.errors[0]).toMatch(reason);
    expect(store.destroyed()).toBe(1);
  });

  it('restores every file when every object is intact', async () => {
    const { connector, service } = make_harness('none');

    const result = await service.restore_sharepoint('tenant-1', 'site-1', {
      snapshot_id: 'sp-snap-1',
    });

    expect(result.files_restored).toBe(3);
    expect(result.errors).toEqual([]);
    expect(uploaded_names(connector)).toHaveLength(3);
  });

  it('stops with the wrong-passphrase error before writing when the key does not unwrap', async () => {
    const wrong_key = new WrongPassphraseError('Could not unwrap the data key');
    const { connector, service } = make_harness('none', () => Promise.reject(wrong_key));

    const restore = service.restore_sharepoint('tenant-1', 'site-1', { snapshot_id: 'sp-snap-1' });

    await expect(restore).rejects.toMatchObject({ code: 'ATLAS_WRONG_PASSPHRASE' });
    expect(connector.create_folder).not.toHaveBeenCalled();
    expect(connector.upload_small_file).not.toHaveBeenCalled();
  });
});
