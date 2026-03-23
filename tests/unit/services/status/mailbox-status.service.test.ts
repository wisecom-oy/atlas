import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { MailboxStatusService } from '@/services/status/mailbox-status.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import type { MailboxConnector, MailFolder, DeltaSyncResult } from '@/ports/mailbox/connector.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant/context.port';
import type { Manifest } from '@/domain/manifest';

function make_folder(name: string, id?: string, count = 10): MailFolder {
  return {
    folder_id: id ?? `id-${name.toLowerCase()}`,
    display_name: name,
    total_item_count: count,
  };
}

function make_manifest(mailbox_id: string, delta_links: Record<string, string>): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    mailbox_id,
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-15T12:00:00Z'),
    total_objects: 5,
    total_size_bytes: 1000,
    delta_links,
    entries: [],
  };
}

function make_mock_context(): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: {
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      delete_version: vi.fn(),
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([]),
      list_versions: vi.fn().mockResolvedValue([]),
      probe_immutability: vi.fn(),
    },
    encrypt: vi.fn(),
    decrypt: vi.fn(),
  };
}

function make_empty_delta(delta_link = 'https://delta/new'): DeltaSyncResult {
  return { messages: [], removed_ids: [], delta_link, delta_reset: false };
}

describe('MailboxStatusService', () => {
  let mock_connector: MailboxConnector;
  let mock_manifests: ManifestRepository;
  let mock_context: TenantContext;
  let service: MailboxStatusService;

  beforeEach(() => {
    mock_context = make_mock_context();

    mock_connector = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi.fn().mockResolvedValue([make_folder('Inbox', 'f1')]),
      fetch_delta: vi.fn().mockResolvedValue(make_empty_delta()),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn().mockResolvedValue([]),
    };

    mock_manifests = {
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
    container.bind(MailboxStatusService).toSelf();

    service = container.get(MailboxStatusService);
  });

  it('throws when mailbox does not exist', async () => {
    vi.mocked(mock_connector.mailbox_exists).mockResolvedValue(false);

    await expect(service.check_mailbox_status('t', 'nobody@test.com')).rejects.toThrow(
      'does not exist in the tenant',
    );
  });

  it('reports never-backed-up folders when no manifest exists', async () => {
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Sent', 'f2'),
    ]);

    const result = await service.check_mailbox_status('t', 'user@test.com');

    expect(result.last_backup_at).toBeUndefined();
    expect(result.last_snapshot_id).toBeUndefined();
    expect(result.is_up_to_date).toBe(false);
    expect(result.folders).toHaveLength(2);
    expect(result.folders[0]!.has_backup).toBe(false);
    expect(result.folders[1]!.has_backup).toBe(false);
    expect(mock_connector.fetch_delta).not.toHaveBeenCalled();
  });

  it('reports up-to-date when delta returns no changes', async () => {
    const manifest = make_manifest('user@test.com', { f1: 'https://delta/link1' });
    vi.mocked(mock_manifests.find_latest_by_mailbox).mockResolvedValue(manifest);
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([make_folder('Inbox', 'f1')]);

    vi.mocked(mock_connector.fetch_delta).mockImplementation(async (_t, _m, _f, _link, on_page) => {
      on_page?.(1, 0, []);
      return { messages: [], removed_ids: [], delta_link: 'https://delta/new', delta_reset: false };
    });

    const result = await service.check_mailbox_status('t', 'user@test.com');

    expect(result.is_up_to_date).toBe(true);
    expect(result.total_pending_changes).toBe(0);
    expect(result.folders[0]!.is_up_to_date).toBe(true);
    expect(result.folders[0]!.has_backup).toBe(true);
    expect(result.last_backup_at).toEqual(new Date('2026-03-15T12:00:00Z'));
    expect(result.last_snapshot_id).toBe('snap-1');
  });

  it('reports pending changes when delta has new messages', async () => {
    const manifest = make_manifest('user@test.com', { f1: 'https://delta/link1' });
    vi.mocked(mock_manifests.find_latest_by_mailbox).mockResolvedValue(manifest);
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([make_folder('Inbox', 'f1')]);

    const fake_msg = {
      message_id: 'msg-1',
      folder_id: 'f1',
      subject: 'New',
      received_at: new Date(),
      size_bytes: 100,
      raw_body: Buffer.from('x'),
      has_attachments: false,
    };

    vi.mocked(mock_connector.fetch_delta).mockImplementation(async (_t, _m, _f, _link, on_page) => {
      on_page?.(1, 1, [fake_msg]);
      return { messages: [], removed_ids: [], delta_link: 'https://delta/new', delta_reset: false };
    });

    const result = await service.check_mailbox_status('t', 'user@test.com');

    expect(result.is_up_to_date).toBe(false);
    expect(result.total_pending_changes).toBe(1);
    expect(result.folders[0]!.pending_new).toBe(1);
  });

  it('reports pending removals from delta removed_ids', async () => {
    const manifest = make_manifest('user@test.com', { f1: 'https://delta/link1' });
    vi.mocked(mock_manifests.find_latest_by_mailbox).mockResolvedValue(manifest);
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([make_folder('Inbox', 'f1')]);

    vi.mocked(mock_connector.fetch_delta).mockImplementation(async (_t, _m, _f, _link, on_page) => {
      on_page?.(1, 0, []);
      return {
        messages: [],
        removed_ids: ['del-1', 'del-2'],
        delta_link: 'https://delta/new',
        delta_reset: false,
      };
    });

    const result = await service.check_mailbox_status('t', 'user@test.com');

    expect(result.is_up_to_date).toBe(false);
    expect(result.total_pending_changes).toBe(2);
    expect(result.folders[0]!.pending_removed).toBe(2);
  });

  it('handles mixed backed-up and never-backed-up folders', async () => {
    const manifest = make_manifest('user@test.com', { f1: 'https://delta/link1' });
    vi.mocked(mock_manifests.find_latest_by_mailbox).mockResolvedValue(manifest);
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Archive', 'f2'),
    ]);

    vi.mocked(mock_connector.fetch_delta).mockImplementation(async (_t, _m, _f, _link, on_page) => {
      on_page?.(1, 0, []);
      return make_empty_delta();
    });

    const result = await service.check_mailbox_status('t', 'user@test.com');

    expect(result.is_up_to_date).toBe(false);
    expect(result.folders[0]!.has_backup).toBe(true);
    expect(result.folders[0]!.is_up_to_date).toBe(true);
    expect(result.folders[1]!.has_backup).toBe(false);
    expect(result.folders[1]!.is_up_to_date).toBe(false);
  });

  it('gracefully handles delta peek errors for individual folders', async () => {
    const manifest = make_manifest('user@test.com', {
      f1: 'https://delta/link1',
      f2: 'https://delta/link2',
    });
    vi.mocked(mock_manifests.find_latest_by_mailbox).mockResolvedValue(manifest);
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([
      make_folder('Inbox', 'f1'),
      make_folder('Sent', 'f2'),
    ]);

    vi.mocked(mock_connector.fetch_delta)
      .mockImplementationOnce(async (_t, _m, _f, _link, on_page) => {
        on_page?.(1, 0, []);
        return make_empty_delta();
      })
      .mockRejectedValueOnce(new Error('Network timeout'));

    const result = await service.check_mailbox_status('t', 'user@test.com');

    expect(result.folders[0]!.is_up_to_date).toBe(true);
    expect(result.folders[1]!.has_backup).toBe(true);
    expect(result.folders[1]!.is_up_to_date).toBe(false);
  });

  it('passes page_size=1 and stops after first page via on_page returning false', async () => {
    const manifest = make_manifest('user@test.com', { f1: 'https://delta/saved' });
    vi.mocked(mock_manifests.find_latest_by_mailbox).mockResolvedValue(manifest);
    vi.mocked(mock_connector.list_mail_folders).mockResolvedValue([make_folder('Inbox', 'f1')]);

    vi.mocked(mock_connector.fetch_delta).mockImplementation(async (_t, _m, _f, _link, on_page) => {
      const should_continue = on_page?.(1, 0, []);
      expect(should_continue).toBe(false);
      return make_empty_delta();
    });

    await service.check_mailbox_status('t', 'user@test.com');

    expect(mock_connector.fetch_delta).toHaveBeenCalledWith(
      't',
      'user@test.com',
      'f1',
      'https://delta/saved',
      expect.any(Function),
      1,
    );
  });
});
