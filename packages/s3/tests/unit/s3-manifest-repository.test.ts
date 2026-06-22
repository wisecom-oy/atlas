import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';
import type { TenantContext } from '@atlas/types';
import type { Manifest } from '@atlas/types';
import { stub_tenant_create_cipher } from '@atlas/types/testing/stub-tenant-create-cipher';

function make_mock_context(): TenantContext {
  return {
    tenant_id: 'test-tenant',
    storage: {
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      delete_version: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
      list_versions: vi.fn().mockResolvedValue([]),
      begin_multipart_upload: vi.fn().mockResolvedValue({
        upload_part: vi.fn(),
        complete: vi.fn(),
        abort: vi.fn(),
      }),
      copy: vi.fn(),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
      probe_immutability: vi.fn(),
    },
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('ENC:'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(4)),
    create_cipher: stub_tenant_create_cipher,
    destroy: vi.fn(),
  };
}

function make_manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    id: 'manifest-1',
    tenant_id: 'test-tenant',
    owner_id: 'user@test.com',
    snapshot_id: 'snap-1',
    created_at: new Date('2026-01-15T10:00:00Z'),
    total_objects: 2,
    total_size_bytes: 1024,
    delta_links: { folder1: 'https://delta/link' },
    entries: [
      {
        object_id: 'msg-1',
        storage_key: 'data/user@test.com/abc',
        checksum: 'abc',
        size_bytes: 512,
      },
      {
        object_id: 'msg-2',
        storage_key: 'data/user@test.com/def',
        checksum: 'def',
        size_bytes: 512,
      },
    ],
    ...overrides,
  };
}

describe('S3ManifestRepository', () => {
  let repo: S3ManifestRepository;
  let ctx: TenantContext;

  beforeEach(() => {
    repo = new S3ManifestRepository();
    ctx = make_mock_context();
  });

  describe('save', () => {
    it('encrypts and stores manifest at correct key', async () => {
      const manifest = make_manifest();
      await repo.save(ctx, manifest);

      expect(ctx.encrypt).toHaveBeenCalledOnce();
      expect(ctx.storage.put).toHaveBeenCalledOnce();
      const [key] = (ctx.storage.put as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(key).toBe('manifests/user@test.com/snap-1.json');
    });

    it('applies effective object lock policy to manifest uploads', async () => {
      const manifest = make_manifest({
        object_lock: {
          requested: {
            mode: 'GOVERNANCE',
            retention_days: 30,
          },
          effective: {
            mode: 'GOVERNANCE',
            retain_until: '2026-04-08T12:00:00.000Z',
          },
        },
      });

      await repo.save(ctx, manifest);

      const put_call = (ctx.storage.put as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(put_call[3]).toEqual({
        mode: 'GOVERNANCE',
        retain_until: '2026-04-08T12:00:00.000Z',
      });
    });
  });

  describe('find_by_snapshot', () => {
    it('returns manifest when found by snapshot suffix', async () => {
      const manifest = make_manifest();
      const json = Buffer.from(JSON.stringify(manifest));
      const encrypted = Buffer.concat([Buffer.from('ENC:'), json]);

      (ctx.storage.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        'manifests/user@test.com/snap-1.json',
      ]);
      (ctx.storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(encrypted);

      const result = await repo.find_by_snapshot(ctx, 'snap-1');
      expect(result).toBeDefined();
      expect(result!.snapshot_id).toBe('snap-1');
    });

    it('returns undefined when no match', async () => {
      (ctx.storage.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await repo.find_by_snapshot(ctx, 'nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('find_latest_by_owner', () => {
    it('returns the most recent manifest', async () => {
      const older = make_manifest({
        id: 'old',
        snapshot_id: 'snap-old',
        created_at: new Date('2025-01-01T00:00:00Z'),
      });
      const newer = make_manifest({
        id: 'new',
        snapshot_id: 'snap-new',
        created_at: new Date('2026-06-01T00:00:00Z'),
      });

      const enc_old = Buffer.concat([Buffer.from('ENC:'), Buffer.from(JSON.stringify(older))]);
      const enc_new = Buffer.concat([Buffer.from('ENC:'), Buffer.from(JSON.stringify(newer))]);

      (ctx.storage.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        'manifests/user@test.com/snap-old.json',
        'manifests/user@test.com/snap-new.json',
      ]);
      (ctx.storage.get as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(enc_old)
        .mockResolvedValueOnce(enc_new);

      const result = await repo.find_latest_by_owner(ctx, 'user@test.com');
      expect(result).toBeDefined();
      expect(result!.id).toBe('new');
    });

    it('returns undefined for empty mailbox', async () => {
      (ctx.storage.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await repo.find_latest_by_owner(ctx, 'user@test.com');
      expect(result).toBeUndefined();
    });
  });
});
