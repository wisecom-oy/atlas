import { describe, expect, it, vi } from 'vitest';
import { drive_chain_reads } from '@wisecom/atlas-types/testing/stub-drive-manifest-chain';
import { readable_manifests } from '@wisecom/atlas-types/testing/readable-listing';
import type {
  OneDriveFileVersionIndexRepository,
  OneDriveManifestEntry,
  OneDriveManifestRepository,
  OneDriveSnapshotManifest,
  TenantContext,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { OneDriveCatalogService } from '@/services/catalog/catalog.service';

function folder(file_id: string, fields: Partial<OneDriveManifestEntry>): OneDriveManifestEntry {
  return {
    file_id,
    drive_id: 'drive-1',
    file_name: file_id,
    parent_path: '/',
    size_bytes: 0,
    backup_at: '2026-11-01T00:00:00Z',
    change_type: 'created',
    kind: 'folder',
    ...fields,
  };
}

function manifest(
  snapshot_id: string,
  created_at: string,
  entries: OneDriveManifestEntry[],
): OneDriveSnapshotManifest {
  return { snapshot_id, created_at: new Date(created_at), entries } as OneDriveSnapshotManifest;
}

function service_over(manifests: OneDriveSnapshotManifest[]): OneDriveCatalogService {
  const ctx = { destroy: vi.fn() } as unknown as TenantContext;
  const factory = {
    create_readonly: vi.fn().mockResolvedValue(ctx),
  } as unknown as TenantContextFactory;
  const repository = {
    find_by_snapshot: vi.fn(async (_ctx: unknown, _owner: string, id: string) =>
      manifests.find((m) => m.snapshot_id === id),
    ),
    list_readable_snapshots_by_owner: vi.fn().mockResolvedValue(readable_manifests(manifests)),
    ...drive_chain_reads('onedrive'),
  } as unknown as OneDriveManifestRepository;
  return new OneDriveCatalogService(factory, repository, {} as OneDriveFileVersionIndexRepository);
}

describe('OneDrive catalog of folder colours (#581)', () => {
  it('lists each live coloured folder at the newest snapshot, by path', async () => {
    const service = service_over([
      manifest('snap-1', '2026-11-01T00:00:00Z', [
        folder('Zeta', { folder_color: { color_hex: '2' } }),
        folder('Alpha', { folder_color: { color_hex: '6' } }),
        folder('Gone', { folder_color: { color_hex: '9' } }),
      ]),
      manifest('snap-2', '2026-11-02T00:00:00Z', [
        folder('Gone', { change_type: 'deleted' }),
        folder('Zeta', { change_type: 'updated', folder_color: { color_hex: '4' } }),
      ]),
    ]);

    const listing = await service.list_onedrive_permissions('tenant-1', 'owner-1');

    expect(listing.snapshot_id).toBe('snap-2');
    expect(listing.items).toEqual([]);
    expect(listing.folder_colors).toEqual([
      { file_id: 'Alpha', drive_id: 'drive-1', path: '/Alpha', folder_color: { color_hex: '6' } },
      { file_id: 'Zeta', drive_id: 'drive-1', path: '/Zeta', folder_color: { color_hex: '4' } },
    ]);
  });

  it('lists no colours for a snapshot taken before colours were captured', async () => {
    const service = service_over([
      manifest('snap-1', '2026-11-01T00:00:00Z', [
        folder('Shared', { permissions: [{ roles: ['read'] }] }),
      ]),
    ]);

    const listing = await service.list_onedrive_permissions('tenant-1', 'owner-1', 'snap-1');

    expect(listing.folder_colors).toEqual([]);
    expect(listing.items).toHaveLength(1);
  });
});
