import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { OneDriveSnapshotManifest, TenantContextFactory } from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3OneDriveManifestRepository } from '@/adapters/s3-onedrive-manifest-repository.adapter';
import { S3OneDriveFileVersionIndexRepository } from '@/adapters/s3-onedrive-file-version-index-repository.adapter';
import { OneDriveQuarantineService } from '@/services/quarantine/quarantine.service';

const OWNER = 'owner-1';
const MANIFEST_KEY = `onedrive/manifests/${OWNER}/od-snap-1000-abc.json`;
const INDEX_KEY = `onedrive/index/${OWNER}/runs/od-snap-1000-abc.json`;

async function rig() {
  const harness = in_memory_tenant_context();
  const manifests = new S3OneDriveManifestRepository();
  const indexes = new S3OneDriveFileVersionIndexRepository();
  await manifests.save(harness.ctx, {
    id: 'm',
    tenant_id: 'tenant-1',
    owner_id: OWNER,
    snapshot_id: 'od-snap-1000-abc',
    created_at: new Date(1000),
    total_files: 0,
    total_size_bytes: 0,
    entries: [],
  } satisfies OneDriveSnapshotManifest);
  await indexes.write_run_index(harness.ctx, OWNER, 'od-snap-1000-abc', [
    { file_id: 'file-1', owner_id: OWNER, versions: [] },
  ]);
  const factory = { create: async () => harness.ctx } as unknown as TenantContextFactory;
  const service = new OneDriveQuarantineService(factory, manifests, indexes);
  const damage = (key: string): void => harness.set_raw(key, Buffer.from('garbage'));
  return { harness, manifests, service, damage };
}

describe('OneDriveQuarantineService (issue #631)', () => {
  it('moves a damaged manifest aside so the listing stops reporting it', async () => {
    const { harness, manifests, service, damage } = await rig();
    damage(MANIFEST_KEY);

    const result = await service.quarantine_unreadable_object('tenant-1', MANIFEST_KEY);

    expect(result).toMatchObject({
      kind: 'manifest',
      quarantine_key: `_quarantine/${MANIFEST_KEY}`,
    });
    const listing = await manifests.list_readable_snapshots_by_owner(harness.ctx, OWNER);
    expect(listing).toEqual({ manifests: [], unreadable_keys: [] });
    expect(harness.raw(`_quarantine/${MANIFEST_KEY}`)).toEqual(Buffer.from('garbage'));
  });

  it('moves a damaged version index aside', async () => {
    const { harness, service, damage } = await rig();
    damage(INDEX_KEY);

    const result = await service.quarantine_unreadable_object('tenant-1', INDEX_KEY);

    expect(result.kind).toBe('version_index');
    expect(harness.raw(INDEX_KEY)).toBeUndefined();
  });

  it('refuses a manifest and a version index that read cleanly', async () => {
    const { harness, service } = await rig();

    await expect(
      service.quarantine_unreadable_object('tenant-1', MANIFEST_KEY),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.quarantine_unreadable_object('tenant-1', INDEX_KEY)).rejects.toThrow(
      /reads cleanly/,
    );
    expect(harness.keys()).toEqual([INDEX_KEY, MANIFEST_KEY]);
  });
});
