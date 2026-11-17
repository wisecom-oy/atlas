import { outlook_stub_chain_reads } from '@wisecom/atlas-types/testing/stub-outlook-manifest-chain';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { SaveService } from '@/services/save/save.service';
import { save_entries_to_archive } from '@/services/save/save-entry-processor';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  NotFoundError,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  MailboxConnector,
  MailFolder,
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';

/**
 * Issue #713: saving the backup of a departed user, whose mailbox Graph answers 404 for, names
 * the archive's folders from the manifests alone.
 */
vi.mock('@/services/save/save-entry-processor', () => ({
  save_entries_to_archive: vi.fn().mockResolvedValue({
    saved_count: 2,
    attachment_count: 0,
    error_count: 0,
    errors: [],
    output_path: 'out.zip',
    total_bytes: 512,
    integrity_failures: [],
    processed: 2,
    interrupted: false,
  }),
}));

const RECORDED_FOLDERS: MailFolder[] = [
  {
    folder_id: 'f1',
    display_name: 'Inbox',
    folder_path: 'Inbox',
    total_item_count: 1,
    well_known_name: 'inbox',
  },
  { folder_id: 'f2', display_name: 'Old', folder_path: 'Inbox/Old', total_item_count: 1 },
];

function make_entry(id: string, folder_id: string): ManifestEntry {
  return {
    object_id: id,
    storage_key: `data/user/${id}`,
    checksum: 'abc',
    size_bytes: 100,
    folder_id,
  };
}

function make_manifest(folders: MailFolder[] | undefined, created_at = new Date()): Manifest {
  const entries = [make_entry('msg-1', 'f1'), make_entry('msg-2', 'f2')];
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: 'departed-owner',
    snapshot_id: 'snap-1',
    created_at,
    total_objects: entries.length,
    total_size_bytes: 200,
    delta_links: {},
    entries,
    ...(folders ? { folders } : {}),
  };
}

/** The folder map the save handed to the archive writer. */
function saved_folder_map(): Record<string, string> {
  return Object.fromEntries(vi.mocked(save_entries_to_archive).mock.lastCall?.[5] ?? []);
}

describe('SaveService when Graph does not serve the source mailbox (issue #713)', () => {
  let mock_manifests: ManifestRepository;
  let mock_connector: MailboxConnector;
  let service: SaveService;

  beforeEach(() => {
    vi.mocked(save_entries_to_archive).mockClear();
    const mock_context = { destroy: vi.fn() } as unknown as TenantContext;
    const mock_factory = {
      create_readonly: vi.fn().mockResolvedValue(mock_context),
    } as unknown as TenantContextFactory;
    mock_manifests = {
      find_by_snapshot: vi.fn().mockResolvedValue(make_manifest(RECORDED_FOLDERS)),
      list_by_owner: vi.fn().mockResolvedValue([make_manifest(RECORDED_FOLDERS)]),
      ...outlook_stub_chain_reads(),
    } as unknown as ManifestRepository;
    mock_connector = {
      list_mail_folders: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('ErrorInvalidUser'), { statusCode: 404 })),
    } as unknown as MailboxConnector;

    const container = new Container();
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
    container.bind(SaveService).toSelf();
    service = container.get(SaveService);
  });

  it('saves a snapshot with the recorded folder paths', async () => {
    await service.save_snapshot('test-tenant', 'snap-1', { output_path: 'out.zip' });

    expect(saved_folder_map()).toEqual({ f1: 'Inbox', f2: 'Inbox/Old' });
    expect(mock_connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it('saves one folder of a mailbox selected by its well-known name', async () => {
    await service.save_mailbox('test-tenant', 'departed-owner', {
      folder_name: 'inbox',
      output_path: 'out.zip',
    });

    const groups = vi.mocked(save_entries_to_archive).mock.lastCall?.[4];
    expect([...(groups?.keys() ?? [])].sort()).toEqual(['f1', 'f2']);
    expect(mock_connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it('names folders that only a snapshot older than the date range records', async () => {
    const older = make_manifest(RECORDED_FOLDERS, new Date('2026-01-01'));
    const in_range = { ...make_manifest(undefined, new Date('2026-06-01')), id: 'manifest-2' };
    vi.mocked(mock_manifests.list_by_owner).mockResolvedValue([older, in_range]);

    await service.save_mailbox('test-tenant', 'departed-owner', {
      start_date: new Date('2026-05-01'),
      output_path: 'out.zip',
    });

    expect(saved_folder_map()).toEqual({ f1: 'Inbox', f2: 'Inbox/Old' });
    expect(mock_connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it('fails before writing when the manifests record no folders and the listing answers 404', async () => {
    vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(make_manifest(undefined));

    await expect(
      service.save_snapshot('test-tenant', 'snap-1', { output_path: 'out.zip' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(save_entries_to_archive).not.toHaveBeenCalled();
  });
});
