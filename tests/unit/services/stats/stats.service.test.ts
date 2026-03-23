import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { StatsService } from '@/services/stats/stats.service';
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
    total_objects: 1,
    total_size_bytes: 100,
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
  };
}

describe('StatsService', () => {
  let mock_manifests: ManifestRepository;
  let service: StatsService;

  beforeEach(() => {
    const mock_context = make_mock_context();

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
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(StatsService).toSelf();

    service = container.get(StatsService);
  });

  // ---------------------------------------------------------------------------
  // get_bucket_stats
  // ---------------------------------------------------------------------------

  describe('get_bucket_stats', () => {
    it('returns zeroed stats when no manifests exist', async () => {
      const result = await service.get_bucket_stats('t');

      expect(result.tenant_id).toBe('t');
      expect(result.mailbox_count).toBe(0);
      expect(result.snapshot_count).toBe(0);
      expect(result.total_messages).toBe(0);
      expect(result.total_size_bytes).toBe(0);
      expect(result.aggregation_us).toBeGreaterThanOrEqual(0);
    });

    it('aggregates across multiple mailboxes', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          mailbox_id: 'alice@test.com',
          entries: [{ object_id: 'o1', storage_key: 'k1', checksum: 'c1', size_bytes: 200 }],
        }),
        make_manifest({
          mailbox_id: 'bob@test.com',
          entries: [{ object_id: 'o2', storage_key: 'k2', checksum: 'c2', size_bytes: 300 }],
        }),
      ]);

      const result = await service.get_bucket_stats('t');

      expect(result.mailbox_count).toBe(2);
      expect(result.snapshot_count).toBe(2);
      expect(result.total_messages).toBe(2);
      expect(result.total_size_bytes).toBe(500);
      expect(result.aggregation_us).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------------------------------------------------------------------------
  // get_mailbox_stats
  // ---------------------------------------------------------------------------

  describe('get_mailbox_stats', () => {
    it('returns zeroed stats when mailbox has no manifests', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({ mailbox_id: 'other@test.com' }),
      ]);

      const result = await service.get_mailbox_stats('t', 'missing@test.com');

      expect(result.mailbox_id).toBe('missing@test.com');
      expect(result.snapshot_count).toBe(0);
      expect(result.total_messages).toBe(0);
      expect(result.aggregation_us).toBeGreaterThanOrEqual(0);
    });

    it('filters manifests to the requested mailbox', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          mailbox_id: 'alice@test.com',
          entries: [
            {
              object_id: 'o1',
              storage_key: 'k1',
              checksum: 'c1',
              size_bytes: 200,
              folder_id: 'inbox',
            },
          ],
        }),
        make_manifest({
          mailbox_id: 'bob@test.com',
          entries: [{ object_id: 'o2', storage_key: 'k2', checksum: 'c2', size_bytes: 300 }],
        }),
        make_manifest({
          mailbox_id: 'alice@test.com',
          entries: [
            {
              object_id: 'o3',
              storage_key: 'k3',
              checksum: 'c3',
              size_bytes: 150,
              folder_id: 'sent',
            },
          ],
        }),
      ]);

      const result = await service.get_mailbox_stats('t', 'alice@test.com');

      expect(result.mailbox_id).toBe('alice@test.com');
      expect(result.snapshot_count).toBe(2);
      expect(result.total_messages).toBe(2);
      expect(result.total_size_bytes).toBe(350);
      expect(result.folders).toHaveLength(2);
    });

    it('normalizes mailbox_id to lowercase', async () => {
      vi.mocked(mock_manifests.list_all_manifests).mockResolvedValue([
        make_manifest({
          mailbox_id: 'alice@test.com',
          entries: [{ object_id: 'o1', storage_key: 'k1', checksum: 'c1', size_bytes: 100 }],
        }),
      ]);

      const result = await service.get_mailbox_stats('t', 'Alice@Test.com');

      expect(result.mailbox_id).toBe('alice@test.com');
      expect(result.snapshot_count).toBe(1);
      expect(result.total_messages).toBe(1);
    });
  });
});
