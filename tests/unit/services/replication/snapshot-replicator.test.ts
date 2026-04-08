import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  replicate_snapshot_to_target,
  collect_storage_keys,
} from '@/services/replication/snapshot-replicator';
import type { Manifest, ManifestEntry, AttachmentEntry } from '@/domain/manifest';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

vi.mock('@/adapters/storage-s3/dek-validator', () => ({
  validate_dek_match: vi.fn().mockResolvedValue(undefined),
}));

function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    delete_version: vi.fn(),
    exists: vi.fn(),
    list: vi.fn(),
    list_versions: vi.fn(),
    probe_immutability: vi.fn(),
  };
}

function make_context(storage: ObjectStorage, tenant_id = 'tenant-1'): TenantContext {
  return {
    tenant_id,
    storage,
    encrypt: vi.fn((data: Buffer) => data),
    decrypt: vi.fn((data: Buffer) => data),
  };
}

function make_entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    object_id: overrides.object_id ?? 'obj-1',
    storage_key: overrides.storage_key ?? 'data/mailbox/key-1',
    checksum: overrides.checksum ?? 'abc123',
    size_bytes: overrides.size_bytes ?? 100,
    subject: overrides.subject,
    folder_id: overrides.folder_id,
    attachments: overrides.attachments,
  };
}

function make_attachment(overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
  return {
    attachment_id: overrides.attachment_id ?? 'att-1',
    name: overrides.name ?? 'file.pdf',
    content_type: overrides.content_type ?? 'application/pdf',
    size_bytes: overrides.size_bytes ?? 50,
    storage_key: overrides.storage_key ?? 'attachments/mailbox/att-key-1',
    checksum: overrides.checksum ?? 'def456',
    is_inline: overrides.is_inline ?? false,
  };
}

function make_manifest(entries: ManifestEntry[]): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    mailbox_id: 'mailbox-1',
    snapshot_id: 'snapshot-1',
    created_at: new Date('2026-01-01'),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((sum, e) => sum + e.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

describe('collect_storage_keys', () => {
  it('collects message and attachment keys', () => {
    const att = make_attachment({ storage_key: 'attachments/mbx/att-hash' });
    const entry = make_entry({
      storage_key: 'data/mbx/msg-hash',
      attachments: [att],
    });
    const manifest = make_manifest([entry]);

    const keys = collect_storage_keys(manifest);

    expect(keys).toEqual(['data/mbx/msg-hash', 'attachments/mbx/att-hash']);
  });

  it('returns empty for manifest with no entries', () => {
    expect(collect_storage_keys(make_manifest([]))).toEqual([]);
  });
});

describe('replicate_snapshot_to_target', () => {
  let source_storage: ObjectStorage;
  let target_storage: ObjectStorage;
  let source_ctx: TenantContext;
  let target_ctx: TenantContext;

  beforeEach(() => {
    source_storage = make_storage();
    target_storage = make_storage();
    source_ctx = make_context(source_storage);
    target_ctx = make_context(target_storage);
  });

  it('copies missing objects and manifest to target', async () => {
    const entry = make_entry({ storage_key: 'data/mailbox-1/hash-1' });
    const manifest = make_manifest([entry]);
    const data_blob = Buffer.from('encrypted-data');
    const manifest_blob = Buffer.from('encrypted-manifest');

    vi.mocked(target_storage.exists).mockResolvedValue(false);
    vi.mocked(source_storage.get).mockImplementation(async (key: string) => {
      if (key === 'data/mailbox-1/hash-1') return data_blob;
      if (key === 'manifests/mailbox-1/snapshot-1.json') return manifest_blob;
      return Buffer.alloc(0);
    });
    vi.mocked(target_storage.get).mockResolvedValue(manifest_blob);

    const result = await replicate_snapshot_to_target(
      source_ctx,
      target_ctx,
      manifest,
      'pass',
      'tenant-1',
    );

    expect(result.objects_copied).toBe(1);
    expect(result.objects_skipped).toBe(0);
    expect(result.objects_failed).toBe(0);
    expect(target_storage.put).toHaveBeenCalledWith('data/mailbox-1/hash-1', data_blob);
    expect(target_storage.put).toHaveBeenCalledWith(
      'manifests/mailbox-1/snapshot-1.json',
      manifest_blob,
    );
  });

  it('skips objects that already exist on target', async () => {
    const entry = make_entry({ storage_key: 'data/mailbox-1/hash-1' });
    const manifest = make_manifest([entry]);
    const manifest_blob = Buffer.from('encrypted-manifest');

    vi.mocked(target_storage.exists).mockImplementation(async (key: string) => {
      if (key === 'data/mailbox-1/hash-1') return true;
      return false;
    });
    vi.mocked(source_storage.get).mockResolvedValue(manifest_blob);
    vi.mocked(target_storage.get).mockResolvedValue(manifest_blob);

    const result = await replicate_snapshot_to_target(
      source_ctx,
      target_ctx,
      manifest,
      'pass',
      'tenant-1',
    );

    expect(result.objects_copied).toBe(0);
    expect(result.objects_skipped).toBe(1);
  });

  it('copies dek.enc and replica marker to target when missing', async () => {
    const manifest = make_manifest([]);
    const dek_blob = Buffer.from('wrapped-dek');
    const manifest_blob = Buffer.from('encrypted-manifest');

    vi.mocked(target_storage.exists).mockResolvedValue(false);
    vi.mocked(source_storage.get).mockImplementation(async (key: string) => {
      if (key === '_meta/dek.enc') return dek_blob;
      return manifest_blob;
    });
    vi.mocked(target_storage.get).mockResolvedValue(manifest_blob);

    await replicate_snapshot_to_target(source_ctx, target_ctx, manifest, 'pass', 'tenant-1');

    expect(target_storage.put).toHaveBeenCalledWith('_meta/dek.enc', dek_blob);
    expect(target_storage.put).toHaveBeenCalledWith('_meta/replica.marker', expect.any(Buffer));
  });

  it('records failure for objects that throw during copy', async () => {
    const entry = make_entry({ storage_key: 'data/mailbox-1/hash-fail' });
    const manifest = make_manifest([entry]);
    const manifest_blob = Buffer.from('encrypted-manifest');

    vi.mocked(target_storage.exists).mockImplementation(async (key: string) => {
      if (key === 'data/mailbox-1/hash-fail') return false;
      return false;
    });
    vi.mocked(source_storage.get).mockImplementation(async (key: string) => {
      if (key === 'data/mailbox-1/hash-fail') throw new Error('Network error');
      return manifest_blob;
    });
    vi.mocked(target_storage.get).mockResolvedValue(manifest_blob);

    const result = await replicate_snapshot_to_target(
      source_ctx,
      target_ctx,
      manifest,
      'pass',
      'tenant-1',
    );

    expect(result.objects_failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Network error');
  });
});
