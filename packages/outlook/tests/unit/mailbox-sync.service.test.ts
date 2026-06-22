import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import type { MailboxConnector, MailMessage, MailFolder, DeltaSyncResult } from '@atlas/types';
import type { ManifestRepository } from '@atlas/types';
import type { TenantContext, TenantContextFactory } from '@atlas/types';
import type { ObjectStorage } from '@atlas/types';
import { SnapshotStatus } from '@atlas/types';
import { stub_tenant_create_cipher } from '@atlas/types/testing/stub-tenant-create-cipher';

function make_message(id: string, body: string, has_attachments = false): MailMessage {
  const raw = Buffer.from(body);
  return {
    message_id: id,
    folder_id: 'folder-1',
    subject: `Subject ${id}`,
    received_at: new Date(),
    size_bytes: raw.length,
    raw_body: raw,
    has_attachments,
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

function make_mock_context(storage?: ObjectStorage): TenantContext {
  const s = storage ?? make_mock_storage();
  return {
    tenant_id: 'test-tenant',
    storage: s,
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
    create_cipher: stub_tenant_create_cipher,
    destroy: vi.fn(),
  };
}

describe('MailboxSyncService', () => {
  let container: Container;
  let mock_connector: MailboxConnector;
  let mock_manifests: ManifestRepository;
  let mock_context: TenantContext;
  let mock_factory: TenantContextFactory;
  let service: MailboxSyncService;

  beforeEach(() => {
    mock_context = make_mock_context();

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

    mock_factory = {
      create: vi.fn().mockResolvedValue(mock_context),
    };

    container = new Container();
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(MailboxSyncService).toSelf();

    service = container.get(MailboxSyncService);
  });

  it('throws when mailbox does not exist in the tenant', async () => {
    (mock_connector.mailbox_exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await expect(service.sync_mailbox('t', 'nobody@test.com')).rejects.toThrow(
      'does not exist in the tenant',
    );

    expect(mock_connector.list_mail_folders).not.toHaveBeenCalled();
  });

  it('creates tenant context for the given tenant', async () => {
    await service.sync_mailbox('tenant-x', 'user@test.com');
    expect(mock_factory.create).toHaveBeenCalledWith('tenant-x');
  });

  it('lists mail folders from connector', async () => {
    await service.sync_mailbox('t', 'user@test.com');
    expect(mock_connector.list_mail_folders).toHaveBeenCalledWith('t', 'user@test.com');
  });

  it('fetches delta for each folder', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Sent', 'f2'),
    ]);

    await service.sync_mailbox('t', 'user@test.com');

    expect(mock_connector.fetch_delta).toHaveBeenCalledTimes(2);
    expect(mock_connector.fetch_delta).toHaveBeenCalledWith(
      't',
      'user@test.com',
      'f1',
      undefined,
      expect.any(Function),
      undefined,
    );
    expect(mock_connector.fetch_delta).toHaveBeenCalledWith(
      't',
      'user@test.com',
      'f2',
      undefined,
      expect.any(Function),
      undefined,
    );
  });

  it('uses content-addressed storage keys', async () => {
    const { createHash: create_hash } = await import('node:crypto');
    const msg = make_message('msg-1', 'unique content');
    const expected_hash = create_hash('sha256').update(msg.raw_body).digest('hex');

    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));

    await service.sync_mailbox('t', 'user@test.com');

    const [key] = (mock_context.storage.put as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(key).toBe(`data/user@test.com/${expected_hash}`);
  });

  it('encrypts data before storing', async () => {
    const msg = make_message('msg-1', 'content');
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));

    await service.sync_mailbox('t', 'user@test.com');

    expect(mock_context.encrypt).toHaveBeenCalledWith(msg.raw_body);
    const [, stored_data] = (mock_context.storage.put as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(stored_data[0]).toBe(0x45);
  });

  it('deduplicates when content already exists', async () => {
    const msg = make_message('msg-1', 'duplicate content');
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));
    vi.mocked(mock_context.storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(mock_context.storage.put).not.toHaveBeenCalled();
    expect(mock_context.encrypt).not.toHaveBeenCalled();
    expect(result.manifest.entries).toHaveLength(1);
  });

  it('stores manifest with per-folder delta links', async () => {
    const msg = make_message('msg-1', 'data');
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg], 'https://new-delta'));

    await service.sync_mailbox('t', 'user@test.com');

    expect(mock_manifests.save).toHaveBeenCalledOnce();
    const [, saved_manifest] = (mock_manifests.save as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(saved_manifest.delta_links).toEqual({ 'folder-1': 'https://new-delta' });
  });

  it('passes previous delta link for incremental sync', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'folder-1', 0),
    ]);

    vi.mocked(mock_manifests.find_latest_by_owner).mockResolvedValue({
      id: 'old-manifest',
      tenant_id: 't',
      owner_id: 'user@test.com',
      snapshot_id: 'old-snap',
      created_at: new Date(),
      total_objects: 0,
      total_size_bytes: 0,
      delta_links: { 'folder-1': 'https://prev-delta' },
      entries: [],
    });

    await service.sync_mailbox('t', 'user@test.com');

    expect(mock_connector.fetch_delta).toHaveBeenCalledWith(
      't',
      'user@test.com',
      'folder-1',
      'https://prev-delta',
      expect.any(Function),
      undefined,
    );
  });

  it('returns completed snapshot with correct counts', async () => {
    const msg = make_message('msg-1', 'body');
    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(result.snapshot.status).toBe(SnapshotStatus.COMPLETED);
    expect(result.snapshot.object_count).toBe(1);
    expect(result.snapshot.completed_at).toBeDefined();
  });

  it('handles empty mailbox gracefully', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([]);

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(result.manifest.entries).toHaveLength(0);
    expect(result.snapshot.status).toBe(SnapshotStatus.COMPLETED);
  });

  it('merges entries across multiple folders', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Sent', 'f2'),
    ]);

    vi.mocked(mock_connector.fetch_delta)
      .mockResolvedValueOnce(make_delta([make_message('m1', 'data1')]))
      .mockResolvedValueOnce(make_delta([make_message('m2', 'data2')]));

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(result.manifest.entries).toHaveLength(2);
    expect(result.manifest.total_objects).toBe(2);
  });

  it('stores checksum as SHA-256 of plaintext in manifest entry', async () => {
    const { createHash: create_hash } = await import('node:crypto');
    const msg = make_message('msg-1', 'test body');
    const expected = create_hash('sha256').update(msg.raw_body).digest('hex');

    vi.mocked(mock_connector.fetch_delta).mockResolvedValue(make_delta([msg]));

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(result.manifest.entries[0].checksum).toBe(expected);
  });

  // ---------------------------------------------------------------------------
  // Folder filtering
  // ---------------------------------------------------------------------------

  it('filters folders by name (case-insensitive)', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Sent Items', 'f2'),
      make_folder('Archive', 'f3'),
    ]);

    await service.sync_mailbox('t', 'user@test.com', { folder_filter: ['inbox', 'Archive'] });

    expect(mock_connector.fetch_delta).toHaveBeenCalledTimes(2);
    const called_ids = vi.mocked(mock_connector.fetch_delta).mock.calls.map((c) => c[2]);
    expect(called_ids).toEqual(['f1', 'f3']);
  });

  it('syncs all folders when no filter is specified', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Sent', 'f2'),
    ]);

    await service.sync_mailbox('t', 'user@test.com');

    expect(mock_connector.fetch_delta).toHaveBeenCalledTimes(2);
  });

  it('continues when a folder fails', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Broken', 'f2'),
      make_folder('Sent', 'f3'),
    ]);

    vi.mocked(mock_connector.fetch_delta)
      .mockResolvedValueOnce(make_delta([make_message('m1', 'd1')]))
      .mockRejectedValueOnce(new Error('folder not found'))
      .mockResolvedValueOnce(make_delta([make_message('m2', 'd2')]));

    const result = await service.sync_mailbox('t', 'user@test.com');

    expect(result.manifest.entries).toHaveLength(2);
    expect(result.snapshot.status).toBe(SnapshotStatus.COMPLETED);
  });
});
