import { outlook_stub_chain_reads } from '@wisecom/atlas-types/testing/stub-outlook-manifest-chain';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { SaveService } from '@/services/save/save.service';
import { save_entries_to_archive } from '@/services/save/save-entry-processor';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  MailboxConnector,
  MailFolder,
  MailFolderListOptions,
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';

/** Issue #700: `save` named a Recoverable Items folder `Unknown` in the archive. */

vi.mock('@/services/save/save-entry-processor', () => ({
  save_entries_to_archive: vi.fn().mockResolvedValue({
    saved_count: 1,
    attachment_count: 0,
    error_count: 0,
    errors: [],
    output_path: 'test.zip',
    total_bytes: 1,
    integrity_failures: [],
    processed: 1,
    interrupted: false,
  }),
}));

const FOLDERS: MailFolder[] = [
  { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox', total_item_count: 1 },
];
const DELETIONS: MailFolder = {
  folder_id: 'ri-del',
  display_name: 'Deletions',
  folder_path: 'Recoverable Items/Deletions',
  total_item_count: 1,
  is_recoverable_items: true,
};

function make_manifest(entries: ManifestEntry[]): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date(),
    total_objects: entries.length,
    total_size_bytes: entries.length,
    delta_links: {},
    entries,
  };
}

function make_service(manifest: Manifest): SaveService {
  const ctx = { destroy: vi.fn() } as unknown as TenantContext;
  const container = new Container();
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue({
    create_readonly: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory);
  container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue({
    find_by_snapshot: vi.fn().mockResolvedValue(manifest),
    list_by_owner: vi.fn().mockResolvedValue([manifest]),
    ...outlook_stub_chain_reads(),
  } as unknown as ManifestRepository);
  container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue({
    list_mail_folders: vi.fn(async (_t: string, _o: string, options?: MailFolderListOptions) =>
      options?.include_recoverable_items === true ? [...FOLDERS, DELETIONS] : FOLDERS,
    ),
  } as unknown as MailboxConnector);
  container.bind(SaveService).toSelf();
  return container.get(SaveService);
}

/** The folder path the archive writer was given for one source folder. */
function archived_folder_path(folder_id: string): string | undefined {
  const folder_map = vi.mocked(save_entries_to_archive).mock.calls[0]![5];
  return folder_map.get(folder_id);
}

describe('Recoverable Items archive path on save (#700)', () => {
  const recoverable: ManifestEntry = {
    object_id: 'r1',
    storage_key: 'data/r1',
    checksum: 'c',
    size_bytes: 1,
    folder_id: 'ri-del',
    recoverable_items: true,
  };

  beforeEach(() => vi.mocked(save_entries_to_archive).mockClear());

  it('names the source folder under Recoverable Items in snapshot mode', async () => {
    const service = make_service(make_manifest([recoverable]));

    await service.save_snapshot('test-tenant', 'snap-1', {
      message_ref: '1',
      include_recoverable_items: true,
    });

    expect(archived_folder_path('ri-del')).toBe('Recoverable Items/Deletions');
  });

  it('selects and names a Recoverable Items folder in mailbox mode', async () => {
    const service = make_service(make_manifest([recoverable]));

    await service.save_mailbox('test-tenant', 'user@test.com', {
      folder_name: 'Recoverable Items/Deletions',
      include_recoverable_items: true,
    });

    expect(archived_folder_path('ri-del')).toBe('Recoverable Items/Deletions');
  });
});
