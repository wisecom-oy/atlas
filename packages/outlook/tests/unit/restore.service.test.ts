import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { RestoreService } from '@/services/restore/restore.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
} from '@atlas/types';
import type { MailboxConnector, MailFolder } from '@atlas/types';
import type { ManifestRepository } from '@atlas/types';
import type { TenantContext, TenantContextFactory } from '@atlas/types';
import type { RestoreConnector } from '@atlas/types';
import type { Manifest, ManifestEntry } from '@atlas/types';
import { stub_tenant_create_cipher } from '@atlas/types/testing/stub-tenant-create-cipher';

function make_entry(id: string, folder_id: string): ManifestEntry {
  return {
    object_id: id,
    storage_key: `data/user/${id}`,
    checksum: id,
    size_bytes: 100,
    subject: `Subject ${id}`,
    folder_id,
  };
}

function make_manifest(entries: ManifestEntry[]): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date(),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((s, e) => s + e.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

function make_stored_message(folder_id: string): Buffer {
  const json = JSON.stringify({
    subject: 'Hello',
    body: { contentType: 'Text', content: 'Hello world' },
    parentFolderId: folder_id,
    receivedDateTime: '2026-01-01T00:00:00Z',
    isRead: true,
  });
  return Buffer.concat([Buffer.from('E'), Buffer.from(json)]);
}

describe('RestoreService', () => {
  let container: Container;
  let mock_context: TenantContext;
  let mock_manifests: ManifestRepository;
  let mock_connector: MailboxConnector;
  let mock_restore: RestoreConnector;
  let service: RestoreService;

  beforeEach(() => {
    mock_context = {
      tenant_id: 'test-tenant',
      storage: {
        put: vi.fn(),
        get: vi.fn().mockImplementation(() => Promise.resolve(make_stored_message('f1'))),
        delete: vi.fn(),
        delete_version: vi.fn(),
        exists: vi.fn(),
        list: vi.fn(),
        list_versions: vi.fn().mockResolvedValue([]),
        begin_multipart_upload: vi.fn().mockResolvedValue({
          upload_part: vi.fn(),
          complete: vi.fn(),
          abort: vi.fn(),
        }),
        copy: vi.fn(),
        abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
        probe_immutability: vi.fn(),
      },
      encrypt: vi.fn(),
      decrypt: vi.fn((data: Buffer) => data.subarray(1)),
      create_cipher: stub_tenant_create_cipher,
    };

    mock_manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_owner: vi.fn(),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };

    const folders: MailFolder[] = [
      { folder_id: 'f1', display_name: 'Inbox', total_item_count: 10 },
      { folder_id: 'f2', display_name: 'Sent', total_item_count: 5 },
    ];

    mock_connector = {
      list_mailboxes: vi.fn(),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi.fn().mockResolvedValue(folders),
      fetch_delta: vi.fn(),
      fetch_message: vi.fn(),
      fetch_attachments: vi.fn(),
    };

    mock_restore = {
      create_mail_folder: vi.fn().mockResolvedValue({
        folder_id: 'restore-root',
        display_name: 'Restore-2026-03-08',
        total_item_count: 0,
      }),
      create_message: vi.fn().mockResolvedValue('new-msg-id'),
      add_attachment: vi.fn(),
      create_upload_session: vi.fn(),
      upload_attachment_chunk: vi.fn(),
      count_folder_messages: vi.fn().mockResolvedValue(0),
      list_folder_messages: vi.fn().mockResolvedValue([]),
    };

    container = new Container();
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue({
      create: vi.fn().mockResolvedValue(mock_context),
    } as unknown as TenantContextFactory);
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(MAILBOX_CONNECTOR_TOKEN).toConstantValue(mock_connector);
    container.bind(RESTORE_CONNECTOR_TOKEN).toConstantValue(mock_restore);
    container.bind(RestoreService).toSelf();

    service = container.get(RestoreService);
  });

  it('throws when target mailbox does not exist', async () => {
    const manifest = make_manifest([make_entry('msg-1', 'f1')]);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (mock_connector.mailbox_exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await expect(
      service.restore_snapshot('test-tenant', 'snap-1', { target_mailbox: 'nobody@test.com' }),
    ).rejects.toThrow('does not exist in the tenant');

    expect(mock_restore.create_mail_folder).not.toHaveBeenCalled();
    expect(mock_restore.create_message).not.toHaveBeenCalled();
  });

  it('throws when source mailbox does not exist (no target override)', async () => {
    const manifest = make_manifest([make_entry('msg-1', 'f1')]);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);
    (mock_connector.mailbox_exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await expect(service.restore_snapshot('test-tenant', 'snap-1')).rejects.toThrow(
      'does not exist in the tenant',
    );
  });

  it('throws when manifest not found', async () => {
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await expect(service.restore_snapshot('test-tenant', 'bad-snap')).rejects.toThrow(
      'No manifest found',
    );
  });

  it('returns empty result when no entries match', async () => {
    const manifest = make_manifest([]);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    const result = await service.restore_snapshot('test-tenant', 'snap-1');
    expect(result.restored_count).toBe(0);
    expect(mock_restore.create_mail_folder).not.toHaveBeenCalled();
  });

  it('restores a single message by index', async () => {
    const entries = [make_entry('msg-1', 'f1'), make_entry('msg-2', 'f1')];
    const manifest = make_manifest(entries);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    const result = await service.restore_snapshot('test-tenant', 'snap-1', {
      message_ref: '1',
    });

    expect(result.restored_count).toBe(1);
    expect(mock_restore.create_message).toHaveBeenCalledTimes(1);
  });

  it('restores messages grouped by folder', async () => {
    const entries = [
      make_entry('msg-1', 'f1'),
      make_entry('msg-2', 'f1'),
      make_entry('msg-3', 'f2'),
    ];
    const manifest = make_manifest(entries);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    const result = await service.restore_snapshot('test-tenant', 'snap-1');

    expect(result.restored_count).toBe(3);
    expect(mock_restore.create_message).toHaveBeenCalledTimes(3);
    expect(mock_restore.create_mail_folder).toHaveBeenCalledTimes(3);
  });

  it('restores attachments alongside messages', async () => {
    const entry: ManifestEntry = {
      ...make_entry('msg-1', 'f1'),
      attachments: [
        {
          attachment_id: 'a1',
          name: 'file.pdf',
          content_type: 'application/pdf',
          size_bytes: 512,
          storage_key: 'attachments/user/hash1',
          checksum: 'hash1',
          is_inline: false,
        },
      ],
    };
    const manifest = make_manifest([entry]);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    const result = await service.restore_snapshot('test-tenant', 'snap-1');

    expect(result.restored_count).toBe(1);
    expect(result.attachment_count).toBe(1);
    expect(mock_restore.add_attachment).toHaveBeenCalledTimes(1);
  });

  it('normalizes target mailbox to lowercase', async () => {
    const entries = [make_entry('msg-1', 'f1')];
    const manifest = make_manifest(entries);
    (mock_manifests.find_by_snapshot as ReturnType<typeof vi.fn>).mockResolvedValue(manifest);

    await service.restore_snapshot('test-tenant', 'snap-1', {
      target_mailbox: 'USER@Test.COM',
    });

    expect(mock_connector.list_mail_folders).toHaveBeenCalledWith('test-tenant', 'user@test.com');
  });

  describe('restore_mailbox', () => {
    it('throws when target mailbox does not exist', async () => {
      (mock_connector.mailbox_exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      await expect(
        service.restore_mailbox('test-tenant', 'user@test.com', {
          target_mailbox: 'nobody@test.com',
        }),
      ).rejects.toThrow('does not exist in the tenant');

      expect(mock_restore.create_mail_folder).not.toHaveBeenCalled();
    });

    it('returns empty when no snapshots for mailbox', async () => {
      (mock_manifests.list_all_manifests as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await service.restore_mailbox('test-tenant', 'user@test.com');
      expect(result.restored_count).toBe(0);
      expect(mock_restore.create_mail_folder).not.toHaveBeenCalled();
    });

    it('merges entries from multiple snapshots and restores', async () => {
      const m1 = {
        ...make_manifest([make_entry('msg-1', 'f1'), make_entry('msg-2', 'f1')]),
        snapshot_id: 'snap-1',
        created_at: new Date('2026-03-08'),
      };
      const m2 = {
        ...make_manifest([make_entry('msg-2', 'f1'), make_entry('msg-3', 'f2')]),
        snapshot_id: 'snap-2',
        created_at: new Date('2026-03-07'),
      };

      (mock_manifests.list_all_manifests as ReturnType<typeof vi.fn>).mockResolvedValue([m1, m2]);

      const result = await service.restore_mailbox('test-tenant', 'user@test.com');
      expect(result.restored_count).toBe(3);
      expect(mock_restore.create_message).toHaveBeenCalledTimes(3);
    });

    it('filters by date range', async () => {
      const old_manifest = {
        ...make_manifest([make_entry('msg-old', 'f1')]),
        snapshot_id: 'snap-old',
        created_at: new Date('2026-01-01'),
      };
      const new_manifest = {
        ...make_manifest([make_entry('msg-new', 'f1')]),
        snapshot_id: 'snap-new',
        created_at: new Date('2026-03-08'),
      };

      (mock_manifests.list_all_manifests as ReturnType<typeof vi.fn>).mockResolvedValue([
        old_manifest,
        new_manifest,
      ]);

      const result = await service.restore_mailbox('test-tenant', 'user@test.com', {
        start_date: new Date('2026-03-01'),
      });

      expect(result.restored_count).toBe(1);
    });

    it('restores to target mailbox when specified', async () => {
      const manifest = {
        ...make_manifest([make_entry('msg-1', 'f1')]),
        snapshot_id: 'snap-1',
        created_at: new Date('2026-03-08'),
      };

      (mock_manifests.list_all_manifests as ReturnType<typeof vi.fn>).mockResolvedValue([manifest]);

      await service.restore_mailbox('test-tenant', 'user@test.com', {
        target_mailbox: 'OTHER@TEST.COM',
      });

      expect(mock_connector.list_mail_folders).toHaveBeenCalledWith('test-tenant', 'user@test.com');
      expect(mock_restore.create_mail_folder).toHaveBeenCalledWith(
        'test-tenant',
        'other@test.com',
        expect.any(String),
      );
    });
  });
});
