import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { DeletionService } from '@/services/deletion/deletion.service';
import {
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  type ManifestRepository,
  type TenantContext,
  type TenantContextFactory,
  type ObjectStorage,
  type Manifest,
} from '@atlas/types';
import { stub_tenant_create_cipher } from '@atlas/types/testing/stub-tenant-create-cipher';

function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 't',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-03-01T10:00:00Z'),
    total_objects: 10,
    total_size_bytes: 1000,
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

function make_mock_context(): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: make_mock_storage(),
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
    create_cipher: stub_tenant_create_cipher,
    destroy: vi.fn(),
  };
}

describe('DeletionService', () => {
  let container: Container;
  let mock_manifests: ManifestRepository;
  let mock_context: TenantContext;
  let mock_factory: TenantContextFactory;
  let service: DeletionService;

  beforeEach(() => {
    mock_context = make_mock_context();

    mock_manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn().mockResolvedValue(undefined),
      find_latest_by_owner: vi.fn().mockResolvedValue(undefined),
      list_all_manifests: vi.fn().mockResolvedValue([]),
    };

    mock_factory = {
      create: vi.fn().mockResolvedValue(mock_context),
      create_storage_only: vi.fn().mockResolvedValue({
        tenant_id: mock_context.tenant_id,
        storage: mock_context.storage,
      }),
    };

    container = new Container();
    container.bind(MANIFEST_REPOSITORY_TOKEN).toConstantValue(mock_manifests);
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(mock_factory);
    container.bind(DeletionService).toSelf();

    service = container.get(DeletionService);
  });

  // ---------------------------------------------------------------------------
  // delete_mailbox_data
  // ---------------------------------------------------------------------------

  describe('delete_mailbox_data', () => {
    it('deletes data, attachment, and manifest keys for a mailbox', async () => {
      const list_fn = vi.mocked(mock_context.storage.list as ReturnType<typeof vi.fn>);
      list_fn
        .mockResolvedValueOnce(['manifests/user@test.com/snap-1.json'])
        .mockResolvedValueOnce(['data/user@test.com/aaa', 'data/user@test.com/bbb'])
        .mockResolvedValueOnce(['attachments/user@test.com/ccc']);

      const result = await service.delete_mailbox_data('t', 'user@test.com');

      expect(result.deleted_objects).toBe(3);
      expect(result.deleted_manifests).toBe(1);
      expect(result.retained_objects).toBe(0);
      expect(result.retained_manifests).toBe(0);
      expect(result.failed_objects).toBe(0);
      expect(result.failed_manifests).toBe(0);
      expect(mock_context.storage.delete).toHaveBeenCalledTimes(4);
      expect(mock_context.storage.delete).toHaveBeenCalledWith('data/user@test.com/aaa');
      expect(mock_context.storage.delete).toHaveBeenCalledWith('attachments/user@test.com/ccc');
      expect(mock_context.storage.delete).toHaveBeenCalledWith(
        'manifests/user@test.com/snap-1.json',
      );
    });

    it('lists correct prefixes with manifests first', async () => {
      await service.delete_mailbox_data('t', 'alice@corp.com');

      expect(mock_context.storage.list).toHaveBeenCalledWith('manifests/alice@corp.com/');
      expect(mock_context.storage.list).toHaveBeenCalledWith('data/alice@corp.com/');
      expect(mock_context.storage.list).toHaveBeenCalledWith('attachments/alice@corp.com/');
    });

    it('returns zeros when mailbox has no data', async () => {
      const result = await service.delete_mailbox_data('t', 'empty@test.com');

      expect(result.deleted_objects).toBe(0);
      expect(result.deleted_manifests).toBe(0);
      expect(result.retained_objects).toBe(0);
      expect(mock_context.storage.delete).not.toHaveBeenCalled();
    });

    it('uses create_storage_only instead of create', async () => {
      await service.delete_mailbox_data('t', 'user@test.com');

      expect(mock_factory.create_storage_only).toHaveBeenCalledWith('t');
      expect(mock_factory.create).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // delete_snapshot
  // ---------------------------------------------------------------------------

  describe('delete_snapshot', () => {
    it('deletes the manifest key and retains data objects', async () => {
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
        make_manifest({ owner_id: 'u@t.com', snapshot_id: 'snap-42' }),
      );
      vi.mocked(mock_context.storage.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        'manifests/u@t.com/snap-42.json',
      ]);

      const result = await service.delete_snapshot('t', 'snap-42');

      expect(result.deleted_manifests).toBe(1);
      expect(result.deleted_objects).toBe(0);
      expect(result.retained_manifests).toBe(0);
      expect(mock_context.storage.delete).toHaveBeenCalledWith('manifests/u@t.com/snap-42.json');
      expect(mock_context.storage.delete).toHaveBeenCalledTimes(1);
    });

    it('returns zeros when snapshot is not found', async () => {
      const result = await service.delete_snapshot('t', 'missing');

      expect(result.deleted_objects).toBe(0);
      expect(result.deleted_manifests).toBe(0);
      expect(result.failed_manifests).toBe(0);
      expect(mock_context.storage.delete).not.toHaveBeenCalled();
    });

    it('reports retained manifest when backend blocks delete with Object Lock', async () => {
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
        make_manifest({ owner_id: 'u@t.com', snapshot_id: 'snap-42' }),
      );
      vi.mocked(mock_context.storage.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        'manifests/u@t.com/snap-42.json',
      ]);
      vi.mocked(mock_context.storage.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('AccessDenied: Object Lock retention in effect'),
      );

      const result = await service.delete_snapshot('t', 'snap-42');

      expect(result.deleted_manifests).toBe(0);
      expect(result.retained_manifests).toBe(1);
      expect(result.failed_manifests).toBe(0);
    });

    it('uses create instead of create_storage_only', async () => {
      await service.delete_snapshot('t', 'missing');

      expect(mock_factory.create).toHaveBeenCalledWith('t');
      expect(mock_factory.create_storage_only).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // purge_tenant
  // ---------------------------------------------------------------------------

  describe('purge_tenant', () => {
    it('deletes data, attachments, manifests, and meta keys', async () => {
      const list_fn = vi.mocked(mock_context.storage.list as ReturnType<typeof vi.fn>);
      list_fn
        .mockResolvedValueOnce(['manifests/u/snap-1.json'])
        .mockResolvedValueOnce(['data/u/aaa', 'data/u/bbb'])
        .mockResolvedValueOnce(['attachments/u/ccc'])
        .mockResolvedValueOnce(['_meta/dek.enc']);

      const result = await service.purge_tenant('t');

      expect(result.deleted_objects).toBe(4);
      expect(result.deleted_manifests).toBe(1);
      expect(result.retained_objects).toBe(0);
      expect(result.failed_manifests).toBe(0);
      expect(mock_context.storage.delete).toHaveBeenCalledTimes(5);
    });

    it('lists the four expected prefixes with manifests first', async () => {
      await service.purge_tenant('t');

      expect(mock_context.storage.list).toHaveBeenCalledWith('manifests/');
      expect(mock_context.storage.list).toHaveBeenCalledWith('data/');
      expect(mock_context.storage.list).toHaveBeenCalledWith('attachments/');
      expect(mock_context.storage.list).toHaveBeenCalledWith('_meta/');
    });

    it('handles empty tenant bucket', async () => {
      const result = await service.purge_tenant('t');

      expect(result.deleted_objects).toBe(0);
      expect(result.deleted_manifests).toBe(0);
      expect(result.retained_objects).toBe(0);
      expect(result.retained_manifests).toBe(0);
    });

    it('uses create_storage_only instead of create', async () => {
      await service.purge_tenant('t');

      expect(mock_factory.create_storage_only).toHaveBeenCalledWith('t');
      expect(mock_factory.create).not.toHaveBeenCalled();
    });
  });
});
