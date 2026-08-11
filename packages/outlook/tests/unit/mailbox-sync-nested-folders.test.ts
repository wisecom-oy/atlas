import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type {
  MailboxConnector,
  MailFolder,
  ManifestRepository,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';

function make_folder(path: string, id: string): MailFolder {
  const segments = path.split('/');
  return {
    folder_id: id,
    display_name: segments[segments.length - 1]!,
    folder_path: path,
    total_item_count: 10,
  };
}

function make_mock_context(): TenantContext {
  return {
    tenant_id: 't',
    storage: {
      put: vi.fn(),
      get: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    },
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from([0]), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
    create_cipher: stub_tenant_create_cipher,
    destroy: vi.fn(),
  } as unknown as TenantContext;
}

/** Folder ids passed to fetch_delta, in call order. */
function synced_folder_ids(connector: MailboxConnector): unknown[] {
  return vi.mocked(connector.fetch_delta).mock.calls.map((c) => c[2]);
}

describe('MailboxSyncService - nested folders', () => {
  let mock_connector: MailboxConnector;
  let service: MailboxSyncService;

  beforeEach(() => {
    mock_connector = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi.fn().mockResolvedValue([]),
      fetch_delta: vi.fn().mockResolvedValue({
        messages: [],
        removed_ids: [],
        delta_link: 'link',
        delta_reset: false,
      }),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn().mockResolvedValue([]),
    };

    const mock_manifests: ManifestRepository = {
      save: vi.fn(),
      find_by_snapshot: vi.fn().mockResolvedValue(undefined),
      find_latest_by_owner: vi.fn().mockResolvedValue(undefined),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };
    const mock_factory = {
      create: vi.fn().mockResolvedValue(make_mock_context()),
    } as unknown as TenantContextFactory;

    const container = new Container();
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(MailboxSyncService).toSelf();

    service = container.get(MailboxSyncService);
  });

  it('backs up folders at every nesting level', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Inbox/Projects', 'f2'),
      make_folder('Inbox/Projects/2026', 'f3'),
    ]);

    await service.sync_mailbox('t', 'user@test.com');

    expect(synced_folder_ids(mock_connector)).toEqual(['f1', 'f2', 'f3']);
  });

  it('selecting a parent folder includes its whole subtree', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Inbox/Projects', 'f2'),
      make_folder('Inbox/Projects/2026', 'f3'),
      make_folder('Archive', 'f4'),
    ]);

    await service.sync_mailbox('t', 'user@test.com', { folder_filter: ['Inbox'] });

    expect(synced_folder_ids(mock_connector)).toEqual(['f1', 'f2', 'f3']);
  });

  it('selects one nested folder by its full path', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Inbox/Projects', 'f2'),
      make_folder('Archive/Projects', 'f3'),
    ]);

    await service.sync_mailbox('t', 'user@test.com', { folder_filter: ['Inbox/Projects'] });

    expect(synced_folder_ids(mock_connector)).toEqual(['f2']);
  });

  it('warns instead of silently syncing nothing when a selector matches no folder', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([make_folder('Inbox', 'f1')]);

    const result = await service.sync_mailbox('t', 'user@test.com', {
      folder_filter: ['Inbox/Nope'],
    });

    expect(synced_folder_ids(mock_connector)).toEqual([]);
    expect(result.summary.warnings.join(' ')).toContain('Inbox/Nope');
  });
});
