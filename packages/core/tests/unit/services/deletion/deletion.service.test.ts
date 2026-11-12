import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, ObjectLockRetainedError } from '@wisecom/atlas-types';
import type { ManifestRepository, TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import type { DeletionService } from '@/services/deletion/deletion.service';
import { deletion_service_rig, make_manifest } from './deletion.service.fixtures';

describe('DeletionService', () => {
  let mock_manifests: ManifestRepository;
  let mock_context: TenantContext;
  let mock_factory: TenantContextFactory;
  let service: DeletionService;

  beforeEach(() => {
    ({ service, mock_manifests, mock_context, mock_factory } = deletion_service_rig());
  });

  // ---------------------------------------------------------------------------
  // delete_mailbox_data
  // ---------------------------------------------------------------------------

  describe('delete_mailbox_data', () => {
    it('deletes data, attachments, manifests, and lookup pointers for a mailbox', async () => {
      const objects_by_prefix: Record<string, string[]> = {
        'manifests/user@test.com/': ['manifests/user@test.com/snap-1.json'],
        '_meta/outlook-manifests/snapshots/snap-1.json': [
          '_meta/outlook-manifests/snapshots/snap-1.json',
        ],
        '_meta/outlook-manifests/owners/user@test.com/': [
          '_meta/outlook-manifests/owners/user@test.com/latest.json',
        ],
        'data/user@test.com/': ['data/user@test.com/aaa', 'data/user@test.com/bbb'],
        'attachments/user@test.com/': ['attachments/user@test.com/ccc'],
      };
      vi.mocked(mock_context.storage.list).mockImplementation(
        async (prefix) => objects_by_prefix[prefix] ?? [],
      );

      const result = await service.delete_mailbox_data('t', 'user@test.com');

      expect(result.deleted_objects).toBe(5);
      expect(result.deleted_manifests).toBe(1);
      expect(result.retained_objects).toBe(0);
      expect(result.retained_manifests).toBe(0);
      expect(result.failed_objects).toBe(0);
      expect(result.failed_manifests).toBe(0);
      expect(mock_context.storage.delete).toHaveBeenCalledTimes(6);
      expect(mock_context.storage.delete).toHaveBeenCalledWith('data/user@test.com/aaa');
      expect(mock_context.storage.delete).toHaveBeenCalledWith('attachments/user@test.com/ccc');
      expect(mock_context.storage.delete).toHaveBeenCalledWith(
        'manifests/user@test.com/snap-1.json',
      );
      expect(mock_context.storage.delete).toHaveBeenCalledWith(
        '_meta/outlook-manifests/snapshots/snap-1.json',
      );
      expect(mock_context.storage.delete).toHaveBeenCalledWith(
        '_meta/outlook-manifests/owners/user@test.com/latest.json',
      );
    });

    it('lists correct prefixes with manifests first', async () => {
      await service.delete_mailbox_data('t', 'alice@corp.com');

      expect(mock_context.storage.list).toHaveBeenCalledWith('manifests/alice@corp.com/');
      expect(mock_context.storage.list).toHaveBeenCalledWith('data/alice@corp.com/');
      expect(mock_context.storage.list).toHaveBeenCalledWith('attachments/alice@corp.com/');
      expect(mock_context.storage.list).toHaveBeenCalledWith(
        '_meta/outlook-manifests/owners/alice@corp.com/',
      );
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
    it('deletes the manifest key and its lookup pointers while retaining data', async () => {
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
        make_manifest({ owner_id: 'u@t.com', snapshot_id: 'snap-42' }),
      );
      const objects_by_prefix: Record<string, string[]> = {
        'manifests/u@t.com/snap-42.json': ['manifests/u@t.com/snap-42.json'],
        '_meta/outlook-manifests/snapshots/snap-42.json': [
          '_meta/outlook-manifests/snapshots/snap-42.json',
        ],
        '_meta/outlook-manifests/owners/u@t.com/latest.json': [
          '_meta/outlook-manifests/owners/u@t.com/latest.json',
        ],
      };
      vi.mocked(mock_context.storage.list).mockImplementation(
        async (prefix) => objects_by_prefix[prefix] ?? [],
      );

      const result = await service.delete_snapshot('t', 'snap-42');

      expect(result.deleted_manifests).toBe(1);
      expect(result.deleted_objects).toBe(2);
      expect(result.retained_manifests).toBe(0);
      expect(mock_context.storage.delete).toHaveBeenCalledWith('manifests/u@t.com/snap-42.json');
      expect(mock_context.storage.delete).toHaveBeenCalledWith(
        '_meta/outlook-manifests/snapshots/snap-42.json',
      );
      expect(mock_context.storage.delete).toHaveBeenCalledWith(
        '_meta/outlook-manifests/owners/u@t.com/latest.json',
      );
      expect(mock_context.storage.delete).toHaveBeenCalledTimes(3);
    });

    it('raises NotFoundError and deletes nothing when the snapshot does not exist', async () => {
      await expect(service.delete_snapshot('t', 'missing')).rejects.toThrow(NotFoundError);

      expect(mock_context.storage.delete).not.toHaveBeenCalled();
    });

    it('reports retained manifest when backend blocks delete with Object Lock', async () => {
      vi.mocked(mock_manifests.find_by_snapshot).mockResolvedValue(
        make_manifest({ owner_id: 'u@t.com', snapshot_id: 'snap-42' }),
      );
      vi.mocked(mock_context.storage.list).mockResolvedValueOnce([
        'manifests/u@t.com/snap-42.json',
      ]);
      vi.mocked(mock_context.storage.delete).mockRejectedValueOnce(
        new ObjectLockRetainedError('manifests/snap-1.json'),
      );

      const result = await service.delete_snapshot('t', 'snap-42');

      expect(result.deleted_manifests).toBe(0);
      expect(result.retained_manifests).toBe(1);
      expect(result.failed_manifests).toBe(0);
    });

    it('fails with NotFoundError and provisions nothing for a tenant without storage (#601)', async () => {
      vi.mocked(mock_factory.create_readonly).mockRejectedValue(new NotFoundError('no backups'));

      await expect(service.delete_snapshot('t', 'snap-42')).rejects.toBeInstanceOf(NotFoundError);

      expect(mock_factory.create).not.toHaveBeenCalled();
      expect(mock_factory.create_storage_only).not.toHaveBeenCalled();
    });
  });
});
