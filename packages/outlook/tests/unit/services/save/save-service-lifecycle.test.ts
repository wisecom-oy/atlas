import { outlook_stub_chain_reads } from '@wisecom/atlas-types/testing/stub-outlook-manifest-chain';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { SaveService } from '@/services/save/save.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@wisecom/atlas-types';
import type { MailboxConnector, MailFolder } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import type { Manifest, ManifestEntry } from '@wisecom/atlas-types';
import { stub_tenant_context } from '@wisecom/atlas-types/testing/stub-tenant-context';

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

const OWNER = 'user@example.com';

function make_manifest(): Manifest {
  const entry: ManifestEntry = {
    object_id: 'msg-1',
    storage_key: 'data/user/msg-1',
    checksum: 'abc',
    size_bytes: 100,
    subject: 'Subject msg-1',
    folder_id: 'f1',
  };
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: OWNER,
    snapshot_id: 'snap-1',
    created_at: new Date(),
    total_objects: 1,
    total_size_bytes: entry.size_bytes,
    delta_links: {},
    entries: [entry],
  };
}

/**
 * Covers steps that run after the tenant context is created but before the save
 * loop starts (folder map lookup in save_batch). A rejection there must still
 * settle the stream target, and the context must outlive the batch it serves.
 */
describe('SaveService batch lifecycle', () => {
  let container: Container;
  let mock_context: TenantContext;
  let mock_manifests: ManifestRepository;
  let mock_connector: MailboxConnector;
  let service: SaveService;

  beforeEach(() => {
    container = new Container();

    mock_context = stub_tenant_context().ctx;
    vi.spyOn(mock_context, 'destroy');

    const mock_factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(mock_context),
      create_readonly: vi.fn().mockResolvedValue(mock_context),
      create_storage_only: vi.fn().mockResolvedValue(mock_context),
    };

    mock_manifests = {
      find_by_snapshot: vi.fn().mockResolvedValue(make_manifest()),
      list_all_manifests: vi.fn().mockResolvedValue([]),
      list_by_owner: vi.fn().mockResolvedValue([make_manifest()]),
      save: vi.fn(),
      list_snapshots: vi.fn().mockResolvedValue([]),
      delete_snapshot: vi.fn(),
      ...outlook_stub_chain_reads(),
    } as unknown as ManifestRepository;

    mock_connector = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi
        .fn()
        .mockResolvedValue([{ folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox' }]),
      fetch_delta: vi.fn(),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn(),
    } as unknown as MailboxConnector;

    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
    container.bind(SaveService).toSelf();

    service = container.get(SaveService);
  });

  it('destroys the stream when save_snapshot rejects before the loop', async () => {
    const sink = new PassThrough();
    vi.mocked(mock_connector.list_mail_folders).mockRejectedValueOnce(
      new Error('folder listing failed'),
    );

    await expect(service.save_snapshot('test-tenant', 'snap-1', { output: sink })).rejects.toThrow(
      'folder listing failed',
    );

    expect(sink.destroyed).toBe(true);
    expect(sink.writableEnded).toBe(false);
  });

  it('destroys the stream when save_mailbox rejects before the loop', async () => {
    const sink = new PassThrough();
    vi.mocked(mock_connector.list_mail_folders).mockRejectedValueOnce(
      new Error('folder listing failed'),
    );

    await expect(service.save_mailbox('test-tenant', OWNER, { output: sink })).rejects.toThrow(
      'folder listing failed',
    );

    expect(sink.destroyed).toBe(true);
    expect(sink.writableEnded).toBe(false);
  });

  it('keeps the tenant context open until save_snapshot settles', async () => {
    const folders = Promise.withResolvers<MailFolder[]>();
    vi.mocked(mock_connector.list_mail_folders).mockImplementationOnce(() => folders.promise);

    const pending = service.save_snapshot('test-tenant', 'snap-1');
    await vi.waitFor(() => expect(mock_connector.list_mail_folders).toHaveBeenCalled());
    expect(mock_context.destroy).not.toHaveBeenCalled();

    folders.resolve([
      { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox', total_item_count: 1 },
    ]);
    await pending;
    expect(mock_context.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps the tenant context open until save_mailbox settles', async () => {
    const folders = Promise.withResolvers<MailFolder[]>();
    vi.mocked(mock_connector.list_mail_folders).mockImplementationOnce(() => folders.promise);

    const pending = service.save_mailbox('test-tenant', OWNER);
    await vi.waitFor(() => expect(mock_connector.list_mail_folders).toHaveBeenCalled());
    expect(mock_context.destroy).not.toHaveBeenCalled();

    folders.resolve([
      { folder_id: 'f1', display_name: 'Inbox', folder_path: 'Inbox', total_item_count: 1 },
    ]);
    await pending;
    expect(mock_context.destroy).toHaveBeenCalledTimes(1);
  });
});
