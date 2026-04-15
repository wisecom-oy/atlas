import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { CatalogService } from '@/services/catalog/catalog.service';
import {
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant/context.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';
import type { Manifest } from '@/domain/manifest';

function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 't',
    mailbox_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-01T10:00:00Z'),
    total_objects: 50,
    total_size_bytes: 5000,
    delta_links: {},
    entries: [],
    ...overrides,
  };
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

function make_mock_context(): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: make_mock_storage(),
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('E'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(1)),
    destroy: vi.fn(),
  };
}

describe('CatalogService', () => {
  let container: Container;
  let mock_manifests: ManifestRepository;
  let mock_context: TenantContext;
  let service: CatalogService;

  beforeEach(() => {
    mock_context = make_mock_context();

    mock_manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn().mockResolvedValue(undefined),
      find_latest_by_mailbox: vi.fn().mockResolvedValue(undefined),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };

    const mock_factory: TenantContextFactory = {
      create: vi.fn().mockResolvedValue(mock_context),
      create_storage_only: vi.fn().mockImplementation(async (tid: string) => ({
        tenant_id: tid,
        storage: mock_context.storage,
      })),
    };

    container = new Container();
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(CatalogService).toSelf();

    service = container.get(CatalogService);
  });

  // ---------------------------------------------------------------------------
  // list_mailboxes
  // ---------------------------------------------------------------------------

  describe('list_mailboxes', () => {
    it('returns empty array when no manifests exist', async () => {
      const result = await service.list_mailboxes('t');
      expect(result).toEqual([]);
    });

    it('groups manifests by mailbox and picks latest for stats', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          mailbox_id: 'alice@test.com',
          snapshot_id: 's1',
          created_at: new Date('2026-03-01'),
          total_objects: 10,
          total_size_bytes: 1000,
        }),
        make_manifest({
          mailbox_id: 'alice@test.com',
          snapshot_id: 's2',
          created_at: new Date('2026-03-05'),
          total_objects: 20,
          total_size_bytes: 2000,
        }),
        make_manifest({
          mailbox_id: 'bob@test.com',
          snapshot_id: 's3',
          created_at: new Date('2026-03-03'),
          total_objects: 5,
          total_size_bytes: 500,
        }),
      ]);

      const result = await service.list_mailboxes('t');

      expect(result).toHaveLength(2);

      const alice = result.find((m) => m.mailbox_id === 'alice@test.com')!;
      expect(alice.snapshot_count).toBe(2);
      expect(alice.total_objects).toBe(20);
      expect(alice.total_size_bytes).toBe(3000);

      const bob = result.find((m) => m.mailbox_id === 'bob@test.com')!;
      expect(bob.snapshot_count).toBe(1);
      expect(bob.total_objects).toBe(5);
    });

    it('returns summaries sorted alphabetically by mailbox_id', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({ mailbox_id: 'zara@test.com', snapshot_id: 's1' }),
        make_manifest({ mailbox_id: 'alice@test.com', snapshot_id: 's2' }),
      ]);

      const result = await service.list_mailboxes('t');
      expect(result[0]!.mailbox_id).toBe('alice@test.com');
      expect(result[1]!.mailbox_id).toBe('zara@test.com');
    });
  });

  // ---------------------------------------------------------------------------
  // list_snapshots
  // ---------------------------------------------------------------------------

  describe('list_snapshots', () => {
    it('returns only snapshots for the specified mailbox', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({ mailbox_id: 'alice@test.com', snapshot_id: 's1' }),
        make_manifest({ mailbox_id: 'bob@test.com', snapshot_id: 's2' }),
        make_manifest({ mailbox_id: 'alice@test.com', snapshot_id: 's3' }),
      ]);

      const result = await service.list_snapshots('t', 'alice@test.com');

      expect(result).toHaveLength(2);
      expect(result.every((m) => m.mailbox_id === 'alice@test.com')).toBe(true);
    });

    it('sorts snapshots newest-first', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          mailbox_id: 'a@t.com',
          snapshot_id: 'old',
          created_at: new Date('2026-01-01'),
        }),
        make_manifest({
          mailbox_id: 'a@t.com',
          snapshot_id: 'new',
          created_at: new Date('2026-03-01'),
        }),
      ]);

      const result = await service.list_snapshots('t', 'a@t.com');

      expect(result[0]!.snapshot_id).toBe('new');
      expect(result[1]!.snapshot_id).toBe('old');
    });

    it('returns empty array when mailbox has no snapshots', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({ mailbox_id: 'other@test.com' }),
      ]);

      const result = await service.list_snapshots('t', 'missing@test.com');
      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // get_snapshot_detail
  // ---------------------------------------------------------------------------

  describe('get_snapshot_detail', () => {
    it('delegates to find_by_snapshot', async () => {
      const manifest = make_manifest({ snapshot_id: 'snap-42' });
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(manifest);

      const result = await service.get_snapshot_detail('t', 'snap-42');

      expect(result).toBe(manifest);
      expect(mock_manifests.find_by_snapshot).toHaveBeenCalledWith(mock_context, 'snap-42');
    });

    it('returns undefined for unknown snapshot', async () => {
      const result = await service.get_snapshot_detail('t', 'nonexistent');
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // read_message
  // ---------------------------------------------------------------------------

  describe('read_message', () => {
    it('decrypts and parses a stored message with empty attachments', async () => {
      const message_json = { subject: 'Hello', body: { content: 'World' } };
      const plaintext = Buffer.from(JSON.stringify(message_json));
      const ciphertext = Buffer.concat([Buffer.from('E'), plaintext]);

      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
        make_manifest({
          entries: [
            { object_id: 'msg-1', storage_key: 'data/u/abc', checksum: 'abc', size_bytes: 100 },
          ],
        }),
      );
      vi.mocked(mock_context.storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(ciphertext);

      const result = await service.read_message('t', 'snap-1', 'msg-1');

      expect(result?.message).toEqual(message_json);
      expect(result?.attachments).toEqual([]);
      expect(mock_context.storage.get).toHaveBeenCalledWith('data/u/abc');
      expect(mock_context.decrypt).toHaveBeenCalledWith(ciphertext);
    });

    it('returns attachment metadata from manifest entry', async () => {
      const message_json = { subject: 'With PDF' };
      const plaintext = Buffer.from(JSON.stringify(message_json));
      const ciphertext = Buffer.concat([Buffer.from('E'), plaintext]);

      const attachment_entry = {
        attachment_id: 'att-1',
        name: 'report.pdf',
        content_type: 'application/pdf',
        size_bytes: 2048,
        storage_key: 'attachments/u/sha',
        checksum: 'sha',
        is_inline: false,
      };

      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
        make_manifest({
          entries: [
            {
              object_id: 'msg-1',
              storage_key: 'data/u/abc',
              checksum: 'abc',
              size_bytes: 100,
              attachments: [attachment_entry],
            },
          ],
        }),
      );
      vi.mocked(mock_context.storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(ciphertext);

      const result = await service.read_message('t', 'snap-1', 'msg-1');

      expect(result?.attachments).toHaveLength(1);
      expect(result?.attachments[0]?.name).toBe('report.pdf');
    });

    it('returns undefined when snapshot does not exist', async () => {
      const result = await service.read_message('t', 'missing', 'msg-1');
      expect(result).toBeUndefined();
    });

    it('returns undefined when message is not in manifest', async () => {
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(make_manifest({ entries: [] }));

      const result = await service.read_message('t', 'snap-1', 'no-such-msg');
      expect(result).toBeUndefined();
    });

    it('resolves message by 1-based index from atlas list output', async () => {
      const message_json = { subject: 'Second' };
      const plaintext = Buffer.from(JSON.stringify(message_json));
      const ciphertext = Buffer.concat([Buffer.from('E'), plaintext]);

      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
        make_manifest({
          entries: [
            { object_id: 'first', storage_key: 'data/k1', checksum: 'a', size_bytes: 1 },
            { object_id: 'second', storage_key: 'data/k2', checksum: 'b', size_bytes: 1 },
          ],
        }),
      );
      vi.mocked(mock_context.storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(ciphertext);

      const result = await service.read_message('t', 'snap-1', '2');

      expect(result?.message).toEqual(message_json);
      expect(mock_context.storage.get).toHaveBeenCalledWith('data/k2');
    });
  });
});
