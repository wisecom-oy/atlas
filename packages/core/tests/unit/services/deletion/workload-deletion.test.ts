/**
 * OneDrive and SharePoint erasure. Both were deleting visible keys only, so in a
 * versioned bucket they reported success while every byte stayed retrievable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Container } from 'inversify';
import 'reflect-metadata';
import { OneDriveDeletionService } from '@/services/deletion/onedrive-deletion.service';
import { SharePointDeletionService } from '@/services/deletion/sharepoint-deletion.service';
import { TENANT_CONTEXT_FACTORY_TOKEN, type TenantContextFactory } from '@wisecom/atlas-types';
import type { DeletionStorage } from '@/services/deletion/shared/prefix-deleter';

const OWNER = '75a21b57-4d82-4f42-9ccc-7c231c30f78c';
const SITE = 'contoso.sharepoint.com,site-guid,web-guid';

function make_storage(): DeletionStorage {
  return {
    delete: vi.fn().mockResolvedValue(undefined),
    delete_version: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    list_versions: vi.fn().mockResolvedValue([]),
  };
}

describe('workload deletion', () => {
  let storage: DeletionStorage;
  let factory: TenantContextFactory;
  let onedrive: OneDriveDeletionService;
  let sharepoint: SharePointDeletionService;

  beforeEach(() => {
    storage = make_storage();
    factory = {
      create: vi.fn(),
      create_storage_only: vi.fn().mockResolvedValue({ tenant_id: 't', storage }),
    };

    const container = new Container();
    container.bind(TENANT_CONTEXT_FACTORY_TOKEN).toConstantValue(factory);
    container.bind(OneDriveDeletionService).toSelf();
    container.bind(SharePointDeletionService).toSelf();

    onedrive = container.get(OneDriveDeletionService);
    sharepoint = container.get(SharePointDeletionService);
  });

  describe('OneDriveDeletionService', () => {
    it('erases versions rather than hiding them behind a delete marker', async () => {
      vi.mocked(storage.list_versions).mockResolvedValueOnce([
        { key: `onedrive/manifests/${OWNER}/snap.json`, version_id: 'v1', is_delete_marker: false },
      ]);

      const result = await onedrive.delete_owner_data('t', OWNER);

      expect(storage.delete_version).toHaveBeenCalledWith(
        `onedrive/manifests/${OWNER}/snap.json`,
        'v1',
      );
      expect(storage.delete).not.toHaveBeenCalled();
      expect(result.deleted_manifests).toBe(1);
    });

    it('sweeps staging, where an interrupted large-file upload parks content', async () => {
      await onedrive.delete_owner_data('t', OWNER);

      const scopes = vi.mocked(storage.list_versions).mock.calls.map(([scope]) => scope);
      expect(scopes).toEqual([
        `onedrive/manifests/${OWNER}/`,
        `onedrive/data/${OWNER}/`,
        `onedrive/index/${OWNER}/`,
        `onedrive/_meta/${OWNER}/`,
        `onedrive/staging/${OWNER}/`,
      ]);
    });

    it('deletes a snapshot manifest version, leaving shared blobs alone', async () => {
      vi.mocked(storage.list_versions).mockResolvedValueOnce([
        { key: `onedrive/manifests/${OWNER}/snap.json`, version_id: 'v1', is_delete_marker: false },
      ]);

      const result = await onedrive.delete_snapshot('t', OWNER, 'snap');

      expect(storage.list_versions).toHaveBeenCalledWith(`onedrive/manifests/${OWNER}/snap.json`);
      expect(result.deleted_manifests).toBe(1);
      expect(result.deleted_objects).toBe(0);
    });

    it('erases without the DEK, so a purged tenant can still be cleaned up', async () => {
      await onedrive.delete_owner_data('t', OWNER);

      expect(factory.create_storage_only).toHaveBeenCalledWith('t');
      expect(factory.create).not.toHaveBeenCalled();
    });
  });

  describe('SharePointDeletionService', () => {
    it('erases versions rather than hiding them behind a delete marker', async () => {
      vi.mocked(storage.list_versions).mockResolvedValueOnce([
        { key: `sharepoint/data/${SITE}/blob`, version_id: 'v1', is_delete_marker: false },
      ]);

      const result = await sharepoint.delete_site_data('t', SITE);

      expect(storage.delete_version).toHaveBeenCalledWith(`sharepoint/data/${SITE}/blob`, 'v1');
      expect(storage.delete).not.toHaveBeenCalled();
      expect(result.deleted_objects).toBe(1);
    });

    it('sweeps staging, where an interrupted large-file upload parks content', async () => {
      await sharepoint.delete_site_data('t', SITE);

      const scopes = vi.mocked(storage.list_versions).mock.calls.map(([scope]) => scope);
      expect(scopes).toContain(`sharepoint/staging/${SITE}/`);
    });

    it('erases without the DEK, so a purged tenant can still be cleaned up', async () => {
      await sharepoint.delete_site_data('t', SITE);

      expect(factory.create_storage_only).toHaveBeenCalledWith('t');
      expect(factory.create).not.toHaveBeenCalled();
    });
  });
});
