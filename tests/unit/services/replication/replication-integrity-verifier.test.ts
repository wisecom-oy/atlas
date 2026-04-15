import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { verify_replicated_snapshot } from '@/services/replication/replication-integrity-verifier';
import { ReplicationVerificationStatus } from '@/domain/replication';
import type { Manifest, ManifestEntry } from '@/domain/manifest';
import type { TenantContext } from '@/ports/tenant/context.port';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';

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

function make_entry(key: string, plaintext: Buffer): ManifestEntry {
  return {
    object_id: `obj-${key}`,
    storage_key: key,
    checksum: createHash('sha256').update(plaintext).digest('hex'),
    size_bytes: plaintext.length,
  };
}

function make_manifest(entries: ManifestEntry[]): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'tenant-1',
    mailbox_id: 'mbx-1',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-01-01'),
    total_objects: entries.length,
    total_size_bytes: entries.reduce((s, e) => s + e.size_bytes, 0),
    delta_links: {},
    entries,
  };
}

describe('verify_replicated_snapshot', () => {
  let storage: ObjectStorage;
  let ctx: TenantContext;

  beforeEach(() => {
    storage = make_storage();
    ctx = {
      tenant_id: 'tenant-1',
      storage,
      encrypt: vi.fn((d: Buffer) => d),
      decrypt: vi.fn((d: Buffer) => d),
      destroy: vi.fn(),
    };
  });

  it('returns PASSED when all checksums match', async () => {
    const plaintext = Buffer.from('hello world');
    const entry = make_entry('data/mbx/hash-1', plaintext);
    const manifest = make_manifest([entry]);

    vi.mocked(storage.get).mockResolvedValue(plaintext);

    const outcome = await verify_replicated_snapshot(ctx, manifest);

    expect(outcome.status).toBe(ReplicationVerificationStatus.PASSED);
    expect(outcome.checked).toBe(1);
    expect(outcome.failed_keys).toEqual([]);
  });

  it('returns FAILED when checksum mismatches', async () => {
    const plaintext = Buffer.from('hello world');
    const entry = make_entry('data/mbx/hash-1', plaintext);
    const manifest = make_manifest([entry]);

    vi.mocked(storage.get).mockResolvedValue(Buffer.from('corrupted'));

    const outcome = await verify_replicated_snapshot(ctx, manifest);

    expect(outcome.status).toBe(ReplicationVerificationStatus.FAILED);
    expect(outcome.failed_keys).toEqual(['data/mbx/hash-1']);
  });

  it('marks objects as failed when get throws', async () => {
    const plaintext = Buffer.from('hello');
    const entry = make_entry('data/mbx/hash-1', plaintext);
    const manifest = make_manifest([entry]);

    vi.mocked(storage.get).mockRejectedValue(new Error('read error'));

    const outcome = await verify_replicated_snapshot(ctx, manifest);

    expect(outcome.status).toBe(ReplicationVerificationStatus.FAILED);
    expect(outcome.failed_keys).toContain('data/mbx/hash-1');
  });
});
