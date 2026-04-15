import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { VerificationService } from '@/services/verification/verification.service';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
import type { TenantContext, TenantContextFactory } from '@/ports/tenant/context.port';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

function make_entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    object_id: overrides.object_id ?? 'obj-1',
    storage_key: overrides.storage_key ?? 'data/mailbox/key-1',
    checksum: overrides.checksum ?? '',
    size_bytes: overrides.size_bytes ?? 0,
    subject: overrides.subject,
    folder_id: overrides.folder_id,
    attachments: overrides.attachments,
  };
}

function make_manifest(entries: ManifestEntry[]): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    mailbox_id: 'mailbox-1',
    snapshot_id: 'snapshot-1',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((sum, entry) => sum + entry.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

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

describe('VerificationService', () => {
  let storage: ObjectStorage;
  let context: TenantContext;
  let tenant_factory: TenantContextFactory;
  let manifests: ManifestRepository;
  let service: VerificationService;

  beforeEach(() => {
    storage = make_storage();
    context = {
      tenant_id: 'tenant-1',
      storage,
      encrypt: vi.fn((data: Buffer) => data),
      decrypt: vi.fn((data: Buffer) => data),
      destroy: vi.fn(),
    };

    tenant_factory = {
      create: vi.fn().mockResolvedValue(context),
      create_storage_only: vi.fn().mockImplementation(async (tid: string) => ({
        tenant_id: tid,
        storage: context.storage,
      })),
    };

    manifests = {
      save: vi.fn(),
      find_by_snapshot: vi.fn(),
      find_latest_by_mailbox: vi.fn(),
      list_all_manifests: vi.fn(),
    };

    service = new VerificationService(tenant_factory, manifests);
  });

  it('marks entry as valid when checksum matches', async () => {
    const plaintext = Buffer.from('hello world');
    const checksum = createHash('sha256').update(plaintext).digest('hex');
    const entry = make_entry({ checksum, size_bytes: plaintext.length });
    const manifest = make_manifest([entry]);

    vi.mocked(storage.exists).mockResolvedValue(true);
    vi.mocked(storage.get).mockResolvedValue(plaintext);
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue(manifest);

    const result = await service.verify_snapshot_integrity('tenant-1', manifest.snapshot_id);

    expect(result.failed).toEqual([]);
    expect(result.passed).toBe(1);
  });

  it('marks entry as corrupt when checksum mismatches', async () => {
    const plaintext = Buffer.from('hello world');
    const checksum = createHash('sha256').update(Buffer.from('different')).digest('hex');
    const entry = make_entry({ checksum, size_bytes: plaintext.length });
    const manifest = make_manifest([entry]);

    vi.mocked(storage.exists).mockResolvedValue(true);
    vi.mocked(storage.get).mockResolvedValue(plaintext);
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue(manifest);

    const result = await service.verify_snapshot_integrity('tenant-1', manifest.snapshot_id);

    expect(result.failed).toEqual([entry.object_id]);
    expect(result.passed).toBe(0);
  });

  it('treats malformed checksum length as corrupt without throwing', async () => {
    const plaintext = Buffer.from('hello world');
    const entry = make_entry({ checksum: 'short', size_bytes: plaintext.length });
    const manifest = make_manifest([entry]);

    vi.mocked(storage.exists).mockResolvedValue(true);
    vi.mocked(storage.get).mockResolvedValue(plaintext);
    vi.mocked(manifests.find_by_snapshot).mockResolvedValue(manifest);

    const result = await service.verify_snapshot_integrity('tenant-1', manifest.snapshot_id);

    expect(result.failed).toEqual([entry.object_id]);
    expect(result.passed).toBe(0);
  });
});
