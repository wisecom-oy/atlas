import 'reflect-metadata';
import { vi } from 'vitest';
import { Container } from 'inversify';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import type {
  MailboxConnector,
  MailMessage,
  DeltaSyncResult,
} from '@/ports/mailbox/connector.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant/context.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

export function make_message(id: string, body: string, has_attachments = false): MailMessage {
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

export function make_delta(
  messages: MailMessage[],
  delta_link = 'https://delta/link',
): DeltaSyncResult {
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
  const resolved_storage = storage ?? make_mock_storage();
  return {
    tenant_id: 'test-tenant',
    storage: resolved_storage,
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
  };
}

export interface MailboxSyncHarness {
  readonly service: MailboxSyncService;
  readonly mock_connector: MailboxConnector;
  readonly mock_context: TenantContext;
}

export function create_mailbox_sync_harness(): MailboxSyncHarness {
  const mock_context = make_mock_context();
  const mock_connector: MailboxConnector = {
    list_mailboxes: vi.fn().mockResolvedValue([]),
    mailbox_exists: vi.fn().mockResolvedValue(true),
    list_mail_folders: vi
      .fn()
      .mockResolvedValue([{ folder_id: 'folder-1', display_name: 'Inbox', total_item_count: 10 }]),
    fetch_delta: vi.fn().mockResolvedValue(make_delta([])),
    fetch_message: vi.fn(),
    fetch_attachments: vi.fn().mockResolvedValue([]),
  };

  const mock_manifests: ManifestRepository = {
    save: vi.fn(),
    find_by_snapshot: vi.fn().mockResolvedValue(undefined),
    find_latest_by_mailbox: vi.fn().mockResolvedValue(undefined),
    list_all_manifests: vi.fn().mockResolvedValue([]),
  };

  const mock_factory: TenantContextFactory = {
    create: vi.fn().mockResolvedValue(mock_context),
  };

  const container = new Container();
  container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
  container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
  container.bind(MailboxSyncService).toSelf();

  return {
    service: container.get(MailboxSyncService),
    mock_connector,
    mock_context,
  };
}
