import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { SaveService } from '@/services/save/save.service';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@atlas/types';
import type { MailboxConnector } from '@atlas/types';
import type { ManifestRepository } from '@atlas/types';
import type { TenantContext, TenantContextFactory } from '@atlas/types';
import type { Manifest, ManifestEntry } from '@atlas/types';

vi.mock('@/services/save/save-entry-processor', () => ({
  save_entries_to_archive: vi.fn().mockResolvedValue({
    saved_count: 2,
    attachment_count: 1,
    error_count: 0,
    errors: [],
    output_path: 'test.zip',
    total_bytes: 1024,
    integrity_failures: [],
  }),
}));

vi.mock('@/services/save/save-progress-dashboard', () => {
  return {
    SaveProgressDashboard: class {
      mark_active = vi.fn();
      update_active = vi.fn();
      mark_done = vi.fn();
      mark_error = vi.fn();
      update_total = vi.fn();
      finish = vi.fn();
      mark_all_pending_interrupted = vi.fn();
    },
  };
});

function make_entry(id: string, folder_id: string): ManifestEntry {
  return {
    object_id: id,
    storage_key: `data/user/${id}`,
    checksum: 'abc',
    size_bytes: 100,
    subject: `Subject ${id}`,
    folder_id,
  };
}

function make_manifest(
  entries: ManifestEntry[],
  opts?: { snapshot_id?: string; owner_id?: string; created_at?: Date },
): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: opts?.owner_id ?? 'user@test.com',
    snapshot_id: opts?.snapshot_id ?? 'snap-1',
    created_at: opts?.created_at ?? new Date(),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((s, e) => s + e.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

describe('SaveService', () => {
  let container: Container;
  let mock_context: TenantContext;
  let mock_manifests: ManifestRepository;
  let mock_connector: MailboxConnector;
  let service: SaveService;

  beforeEach(() => {
    container = new Container();

    mock_context = {
      storage: {
        get: vi.fn().mockResolvedValue(Buffer.from('encrypted')),
        put: vi.fn(),
        exists: vi.fn(),
        delete: vi.fn(),
      },
      decrypt: vi.fn((buf: Buffer) => buf),
      encrypt: vi.fn((buf: Buffer) => buf),
    } as unknown as TenantContext;

    const mock_factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(mock_context),
    };

    mock_manifests = {
      find_by_snapshot: vi.fn(),
      list_all_manifests: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      list_snapshots: vi.fn().mockResolvedValue([]),
      delete_snapshot: vi.fn(),
    } as unknown as ManifestRepository;

    mock_connector = {
      list_mailboxes: vi.fn().mockResolvedValue([]),
      mailbox_exists: vi.fn().mockResolvedValue(true),
      list_mail_folders: vi.fn().mockResolvedValue([
        { folder_id: 'f1', display_name: 'Inbox' },
        { folder_id: 'f2', display_name: 'Sent Items' },
      ]),
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

  describe('save_snapshot', () => {
    it('saves messages from a snapshot', async () => {
      const entries = [make_entry('msg-1', 'f1'), make_entry('msg-2', 'f1')];
      const manifest = make_manifest(entries);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'snap-1');

      expect(result.saved_count).toBe(2);
      expect(result.snapshot_id).toBe('snap-1');
    });

    it('returns empty result when no entries', async () => {
      const manifest = make_manifest([]);
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.save_snapshot('test-tenant', 'snap-1');

      expect(result.saved_count).toBe(0);
    });

    it('throws when manifest not found', async () => {
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
        undefined as unknown as Manifest,
      );

      await expect(service.save_snapshot('test-tenant', 'snap-bad')).rejects.toThrow(
        'No manifest found',
      );
    });
  });

  describe('save_mailbox', () => {
    it('merges snapshots and saves messages', async () => {
      const entries = [make_entry('msg-1', 'f1')];
      const manifest = make_manifest(entries, { owner_id: 'user@test.com' });
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([manifest]);

      const result = await service.save_mailbox('test-tenant', 'user@test.com');

      expect(result.saved_count).toBe(2);
    });

    it('returns empty result when no snapshots', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([]);

      const result = await service.save_mailbox('test-tenant', 'user@test.com');

      expect(result.saved_count).toBe(0);
    });
  });
});
