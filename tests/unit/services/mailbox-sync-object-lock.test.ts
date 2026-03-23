import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import type { MailboxConnector } from '@/ports/mailbox/connector.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant/context.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

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

describe('MailboxSyncService object lock', () => {
  let mock_connector: MailboxConnector;
  let mock_context: TenantContext;
  let service: MailboxSyncService;

  beforeEach(() => {
    mock_context = {
      tenant_id: 'test-tenant',
      storage: make_mock_storage(),
      encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
      decrypt: vi.fn((data: Buffer) => data.subarray(1)),
    };

    const message = {
      message_id: 'msg-1',
      folder_id: 'folder-1',
      subject: 'Subject',
      received_at: new Date(),
      size_bytes: 10,
      raw_body: Buffer.from('immutable content'),
      has_attachments: false,
    };

    mock_connector = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi
        .fn()
        .mockResolvedValue([{ folder_id: 'folder-1', display_name: 'Inbox', total_item_count: 1 }]),
      fetch_delta: vi.fn().mockResolvedValue({
        messages: [message],
        removed_ids: [],
        delta_link: 'delta',
        delta_reset: false,
      }),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn().mockResolvedValue([]),
    };

    const mock_manifests: ManifestRepository = {
      save: vi.fn(),
      find_by_snapshot: vi.fn().mockResolvedValue(undefined),
      find_latest_by_mailbox: vi.fn().mockResolvedValue(undefined),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };

    const factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(mock_context),
    };

    const container = new Container();
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(factory);
    container.bind(MailboxSyncService).toSelf();
    service = container.get(MailboxSyncService);
  });

  it('skips upload for deduplicated content even when Object Lock is active', async () => {
    vi.mocked(mock_context.storage.exists as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await service.sync_mailbox('t', 'user@test.com', {
      object_lock_policy: {
        mode: 'GOVERNANCE',
        retain_until: '2026-04-08T12:00:00.000Z',
      },
    });

    await service.sync_mailbox('t', 'user@test.com', {
      object_lock_policy: {
        mode: 'GOVERNANCE',
        retain_until: '2026-06-08T12:00:00.000Z',
      },
    });

    expect(mock_context.storage.put).toHaveBeenCalledTimes(1);
  });

  it('stores requested and effective object lock policy in manifest', async () => {
    const result = await service.sync_mailbox('t', 'user@test.com', {
      object_lock_policy: {
        mode: 'GOVERNANCE',
        retain_until: '2026-04-08T12:00:00.000Z',
      },
      object_lock_request: {
        mode: 'GOVERNANCE',
        retention_days: 30,
      },
    });

    expect(result.manifest.object_lock).toEqual({
      requested: {
        mode: 'GOVERNANCE',
        retention_days: 30,
      },
      effective: {
        mode: 'GOVERNANCE',
        retain_until: '2026-04-08T12:00:00.000Z',
      },
    });
  });
});
