/**
 * Issue #190: a drive snapshot whose blobs did not all copy must leave no manifest on the target.
 *
 * The storage fakes are Map-backed rather than assertion-only mocks on purpose. What makes the bug
 * sticky is the interaction between the manifest write and the presence check that decides whether a
 * snapshot still needs replicating, so the diff assertions here read the target the replicator
 * actually wrote instead of a hardcoded list.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  ObjectStorage,
  OneDriveSnapshotManifest,
  SharePointSnapshotManifest,
  TenantContext,
} from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_decipher } from '@wisecom/atlas-types/testing/stub-tenant-create-decipher';
import { replicate_onedrive_snapshot } from '@/services/replication/onedrive-snapshot-replicator';
import { replicate_sharepoint_snapshot } from '@/services/replication/sharepoint-snapshot-replicator';
import { diff_od_manifests } from '@/services/replication/onedrive-replication-helpers';
import { diff_sp_manifests } from '@/services/replication/sharepoint-replication-helpers';

const OD_MANIFEST_KEY = 'onedrive/manifests/owner-1/snapshot-1.json';
const SP_MANIFEST_KEY = 'sharepoint/manifests/site-1/snapshot-1.json';
const OD_DATA_KEY = 'onedrive/data/owner-1/hash-1';
const SP_DATA_KEY = 'sharepoint/data/site-1/hash-1';

function make_storage(
  objects: Map<string, Buffer>,
  reject_put: readonly string[] = [],
): ObjectStorage {
  return {
    put: vi.fn(async (key: string, data: Buffer) => {
      if (reject_put.includes(key)) throw new Error('AccessDenied');
      objects.set(key, data);
    }),
    get: vi.fn(async (key: string) => {
      const value = objects.get(key);
      if (!value) throw new Error(`NoSuchKey: ${key}`);
      return value;
    }),
    exists: vi.fn(async (key: string) => objects.has(key)),
    list: vi.fn(async (prefix: string) =>
      [...objects.keys()].filter((key) => key.startsWith(prefix)),
    ),
    delete: vi.fn(),
    delete_version: vi.fn(),
    list_versions: vi.fn(),
    begin_multipart_upload: vi.fn(),
    copy: vi.fn(),
    get_with_etag: vi.fn(),
    get_stream: vi.fn(),
    apply_default_retention: vi.fn(),
    abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
    probe_immutability: vi.fn(),
  };
}

function make_context(storage: ObjectStorage, tenant_id = 'tenant-1'): TenantContext {
  return {
    tenant_id,
    storage,
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
    create_cipher: stub_tenant_create_cipher,
    create_decipher: stub_tenant_create_decipher,
    destroy: vi.fn(),
  };
}

/** A source holding the DEK, one data blob and the snapshot manifest. */
function make_source(manifest_key: string, data_key: string): Map<string, Buffer> {
  return new Map([
    ['_meta/dek.enc', Buffer.from('wrapped-dek')],
    [data_key, Buffer.from('ciphertext')],
    [manifest_key, Buffer.from('encrypted-manifest')],
  ]);
}

function make_od_manifest(): OneDriveSnapshotManifest {
  return {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    owner_id: 'owner-1',
    snapshot_id: 'snapshot-1',
    created_at: new Date('2026-01-01'),
    total_files: 1,
    total_size_bytes: 10,
    entries: [
      {
        file_id: 'file-1',
        drive_id: 'drive-1',
        file_name: 'Report.docx',
        parent_path: '/',
        size_bytes: 10,
        storage_key: OD_DATA_KEY,
        backup_at: '2026-01-01T00:00:00.000Z',
        change_type: 'created',
      },
    ],
  };
}

function make_sp_manifest(): SharePointSnapshotManifest {
  return {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    site_id: 'site-1',
    snapshot_id: 'snapshot-1',
    created_at: new Date('2026-01-01'),
    total_files: 1,
    total_size_bytes: 10,
    entries: [
      {
        file_id: 'file-1',
        drive_id: 'drive-1',
        file_name: 'Budget.xlsx',
        parent_path: '/',
        size_bytes: 10,
        storage_key: SP_DATA_KEY,
        backup_at: '2026-01-01T00:00:00.000Z',
        change_type: 'created',
      },
    ],
  };
}

describe('replicate_onedrive_snapshot manifest gate (#190)', () => {
  it('writes no manifest when a data blob fails to copy, and still reports the tally', async () => {
    const target_objects = new Map<string, Buffer>();
    const source_ctx = make_context(make_storage(make_source(OD_MANIFEST_KEY, OD_DATA_KEY)));
    const target_ctx = make_context(make_storage(target_objects, [OD_DATA_KEY]));

    const result = await replicate_onedrive_snapshot(
      source_ctx,
      target_ctx,
      make_od_manifest(),
      OD_MANIFEST_KEY,
    );

    expect(result.objects_failed).toBe(1);
    expect(result.objects_copied).toBe(0);
    expect(result.errors[0]).toContain('AccessDenied');
    expect(result.source_manifest_checksum).toBe('');
    expect(result.replicated_manifest_checksum).toBe('');
    expect(target_objects.has(OD_MANIFEST_KEY)).toBe(false);
  });

  it('leaves the snapshot unreplicated so the next run retries it', async () => {
    const target_objects = new Map<string, Buffer>();
    const source_ctx = make_context(make_storage(make_source(OD_MANIFEST_KEY, OD_DATA_KEY)));
    const target_ctx = make_context(make_storage(target_objects, [OD_DATA_KEY]));
    const manifest = make_od_manifest();

    await replicate_onedrive_snapshot(source_ctx, target_ctx, manifest, OD_MANIFEST_KEY);

    const pending = await diff_od_manifests([manifest], target_ctx, 'owner-1');
    expect(pending.map((m) => m.snapshot_id)).toEqual(['snapshot-1']);
  });

  it('writes no manifest when an ancillary object fails to copy', async () => {
    const index_key = 'onedrive/index/owner-1/runs/snapshot-1.json';
    const source_objects = make_source(OD_MANIFEST_KEY, OD_DATA_KEY);
    source_objects.set(index_key, Buffer.from('version-index'));
    const target_objects = new Map<string, Buffer>();
    const source_ctx = make_context(make_storage(source_objects));
    const target_ctx = make_context(make_storage(target_objects, [index_key]));

    const result = await replicate_onedrive_snapshot(
      source_ctx,
      target_ctx,
      make_od_manifest(),
      OD_MANIFEST_KEY,
      { ancillary_keys: [index_key] },
    );

    expect(result.objects_failed).toBe(1);
    expect(target_objects.has(OD_MANIFEST_KEY)).toBe(false);
  });

  it('still writes the manifest when every object copies', async () => {
    const target_objects = new Map<string, Buffer>();
    const source_ctx = make_context(make_storage(make_source(OD_MANIFEST_KEY, OD_DATA_KEY)));
    const target_ctx = make_context(make_storage(target_objects));
    const manifest = make_od_manifest();

    const result = await replicate_onedrive_snapshot(
      source_ctx,
      target_ctx,
      manifest,
      OD_MANIFEST_KEY,
    );

    expect(result.objects_failed).toBe(0);
    expect(result.objects_copied).toBe(1);
    expect(result.source_manifest_checksum).toBe(result.replicated_manifest_checksum);
    expect(target_objects.has(OD_MANIFEST_KEY)).toBe(true);
    expect(await diff_od_manifests([manifest], target_ctx, 'owner-1')).toEqual([]);
  });
});

describe('replicate_sharepoint_snapshot manifest gate (#190)', () => {
  it('writes no manifest when a data blob fails to copy, and still reports the tally', async () => {
    const target_objects = new Map<string, Buffer>();
    const source_ctx = make_context(make_storage(make_source(SP_MANIFEST_KEY, SP_DATA_KEY)));
    const target_ctx = make_context(make_storage(target_objects, [SP_DATA_KEY]));

    const result = await replicate_sharepoint_snapshot(
      source_ctx,
      target_ctx,
      make_sp_manifest(),
      SP_MANIFEST_KEY,
    );

    expect(result.objects_failed).toBe(1);
    expect(result.objects_copied).toBe(0);
    expect(result.errors[0]).toContain('AccessDenied');
    expect(result.source_manifest_checksum).toBe('');
    expect(result.replicated_manifest_checksum).toBe('');
    expect(target_objects.has(SP_MANIFEST_KEY)).toBe(false);
  });

  it('leaves the snapshot unreplicated so the next run retries it', async () => {
    const target_objects = new Map<string, Buffer>();
    const source_ctx = make_context(make_storage(make_source(SP_MANIFEST_KEY, SP_DATA_KEY)));
    const target_ctx = make_context(make_storage(target_objects, [SP_DATA_KEY]));
    const manifest = make_sp_manifest();

    await replicate_sharepoint_snapshot(source_ctx, target_ctx, manifest, SP_MANIFEST_KEY);

    const pending = await diff_sp_manifests([manifest], target_ctx, 'site-1');
    expect(pending.map((m) => m.snapshot_id)).toEqual(['snapshot-1']);
  });

  it('still writes the manifest when every object copies', async () => {
    const target_objects = new Map<string, Buffer>();
    const source_ctx = make_context(make_storage(make_source(SP_MANIFEST_KEY, SP_DATA_KEY)));
    const target_ctx = make_context(make_storage(target_objects));
    const manifest = make_sp_manifest();

    const result = await replicate_sharepoint_snapshot(
      source_ctx,
      target_ctx,
      manifest,
      SP_MANIFEST_KEY,
    );

    expect(result.objects_failed).toBe(0);
    expect(result.source_manifest_checksum).toBe(result.replicated_manifest_checksum);
    expect(target_objects.has(SP_MANIFEST_KEY)).toBe(true);
    expect(await diff_sp_manifests([manifest], target_ctx, 'site-1')).toEqual([]);
  });
});
