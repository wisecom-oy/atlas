import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  type MailboxConnector,
  type MailMessage,
  type MailFolder,
  type DeltaSyncResult,
  type ManifestRepository,
  type TenantContext,
  type TenantContextFactory,
  type ObjectStorage,
} from '@atlas/types';
import { stub_tenant_create_cipher } from '@atlas/types/testing/stub-tenant-create-cipher';

function make_message(id: string, body: string): MailMessage {
  const raw = Buffer.from(body);
  return {
    message_id: id,
    folder_id: 'folder-1',
    subject: `Subject ${id}`,
    received_at: new Date(),
    size_bytes: raw.length,
    raw_body: raw,
    has_attachments: false,
  };
}

function make_folder(name: string, id?: string, count = 10): MailFolder {
  return {
    folder_id: id ?? `id-${name.toLowerCase()}`,
    display_name: name,
    total_item_count: count,
  };
}

function make_delta(messages: MailMessage[], delta_link = 'https://delta/link'): DeltaSyncResult {
  return { messages, removed_ids: [], delta_link, delta_reset: false };
}

function make_mock_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
    begin_multipart_upload: vi.fn().mockResolvedValue({
      upload_part: vi.fn(),
      complete: vi.fn(),
      abort: vi.fn(),
    }),
    copy: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn().mockResolvedValue({
      bucket: 'test-bucket',
      reachable: true,
      versioning_enabled: true,
      object_lock_enabled: true,
      mode_supported: true,
    }),
  };
}

describe('MailboxSyncService – force_full / stale-delta safeguard', () => {
  let mock_connector: MailboxConnector;
  let mock_manifests: ManifestRepository;
  let service: MailboxSyncService;

  beforeEach(() => {
    const storage = make_mock_storage();
    const mock_context: TenantContext = {
      tenant_id: 'test-tenant',
      storage,
      encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
      decrypt: vi.fn((data: Buffer) => data.subarray(1)),
      create_cipher: stub_tenant_create_cipher,
    };

    mock_connector = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi.fn().mockResolvedValue([make_folder('Inbox', 'folder-1')]),
      fetch_delta: vi.fn().mockResolvedValue(make_delta([])),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn().mockResolvedValue([]),
    };

    mock_manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn().mockResolvedValue(undefined),
      find_latest_by_owner: vi.fn().mockResolvedValue(undefined),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };

    const mock_factory: TenantContextFactory = { create: vi.fn().mockResolvedValue(mock_context) };

    const container = new Container();
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(MailboxSyncService).toSelf();
    service = container.get(MailboxSyncService);
  });

  it('ignores saved delta links when force_full is true', async () => {
    vi.mocked(mock_manifests.find_latest_by_owner).mockResolvedValue({
      id: 'old',
      tenant_id: 't',
      owner_id: 'user@test.com',
      snapshot_id: 'old-snap',
      created_at: new Date(),
      total_objects: 0,
      total_size_bytes: 0,
      delta_links: { 'folder-1': 'https://stale-delta' },
      entries: [],
    });

    await service.sync_mailbox('t', 'user@test.com', { force_full: true });

    expect(mock_connector.fetch_delta).toHaveBeenCalledWith(
      't',
      'user@test.com',
      'folder-1',
      undefined,
      expect.any(Function),
      undefined,
    );
  });

  it('retries without delta link when saved delta returns 0 and prior backup was empty', async () => {
    vi.mocked(mock_manifests.find_latest_by_owner).mockResolvedValue({
      id: 'old',
      tenant_id: 't',
      owner_id: 'user@test.com',
      snapshot_id: 'old-snap',
      created_at: new Date(),
      total_objects: 0,
      total_size_bytes: 0,
      delta_links: { 'folder-1': 'https://stale-delta' },
      entries: [],
    });

    const fresh_msg = make_message('fresh-1', 'fresh content');
    vi.mocked(mock_connector.fetch_delta)
      .mockResolvedValueOnce(make_delta([]))
      .mockResolvedValueOnce(make_delta([fresh_msg]));

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(mock_connector.fetch_delta).toHaveBeenCalledTimes(2);
    expect(mock_connector.fetch_delta).toHaveBeenNthCalledWith(
      1,
      't',
      'user@test.com',
      'folder-1',
      'https://stale-delta',
      expect.any(Function),
      undefined,
    );
    expect(mock_connector.fetch_delta).toHaveBeenNthCalledWith(
      2,
      't',
      'user@test.com',
      'folder-1',
      undefined,
      expect.any(Function),
      undefined,
    );
    expect(result.manifest.entries).toHaveLength(1);
  });

  it('trusts delta returning 0 when prior backup had data (nothing changed)', async () => {
    vi.mocked(mock_manifests.find_latest_by_owner).mockResolvedValue({
      id: 'old',
      tenant_id: 't',
      owner_id: 'user@test.com',
      snapshot_id: 'old-snap',
      created_at: new Date(),
      total_objects: 100,
      total_size_bytes: 5000,
      delta_links: { 'folder-1': 'https://valid-delta' },
      entries: [],
    });

    vi.mocked(mock_connector.fetch_delta).mockResolvedValueOnce(make_delta([]));
    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(mock_connector.fetch_delta).toHaveBeenCalledTimes(1);
    expect(result.manifest.entries).toHaveLength(0);
  });
});
