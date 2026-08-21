import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';
import type { TenantContext } from '@wisecom/atlas-types';
import type { Manifest } from '@wisecom/atlas-types';
import { stub_tenant_create_cipher } from '@wisecom/atlas-types/testing/stub-tenant-create-cipher';
import { stub_tenant_create_decipher } from '@wisecom/atlas-types/testing/stub-tenant-create-decipher';

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
      get_with_etag: vi.fn(),
      get_stream: vi.fn(),
      apply_default_retention: vi.fn(),
      abort_incomplete_uploads: vi.fn().mockResolvedValue(0),
      probe_immutability: vi.fn(),
    },
    encrypt: vi.fn((data: Buffer) => Buffer.concat([Buffer.from('ENC:'), data])),
    decrypt: vi.fn((data: Buffer) => data.subarray(4)),
    create_cipher: stub_tenant_create_cipher,
    create_decipher: stub_tenant_create_decipher,
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

function encrypted_json(value: unknown): Buffer {
  return Buffer.concat([Buffer.from('ENC:'), Buffer.from(JSON.stringify(value))]);
}

describe('S3ManifestRepository', () => {
  let repo: S3ManifestRepository;
  let ctx: TenantContext;

  beforeEach(() => {
    repo = new S3ManifestRepository();
    ctx = make_mock_context();
  });

  describe('save', () => {
    it('stores the manifest and its encrypted lookup pointers', async () => {
      const manifest = make_manifest();
      await repo.save(ctx, manifest);

      expect(ctx.encrypt).toHaveBeenCalledTimes(2);
      const put_calls = vi.mocked(ctx.storage.put).mock.calls;
      expect(put_calls.map((call) => call[0])).toEqual([
        'manifests/user@test.com/snap-1.json',
        '_meta/outlook-manifests/snapshots/snap-1.json',
        '_meta/outlook-manifests/owners/user@test.com/latest.json',
      ]);
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

      const put_call = vi.mocked(ctx.storage.put).mock.calls[0]!;
      expect(put_call[3]).toEqual({
        mode: 'GOVERNANCE',
        retain_until: '2026-04-08T12:00:00.000Z',
      });
    });
  });

  describe('find_by_snapshot', () => {
    it('loads an indexed snapshot without listing owner prefixes', async () => {
      const manifest = make_manifest();
      const pointer = encrypted_json({
        manifest_key: 'manifests/user@test.com/snap-1.json',
      });
      vi.mocked(ctx.storage.get)
        .mockResolvedValueOnce(pointer)
        .mockResolvedValueOnce(encrypted_json(manifest));

      const result = await repo.find_by_snapshot(ctx, 'snap-1');

      expect(result?.snapshot_id).toBe('snap-1');
      expect(ctx.storage.list).not.toHaveBeenCalled();
      expect(ctx.storage.get).toHaveBeenCalledTimes(2);
    });

    it('falls back to the legacy manifest layout', async () => {
      const manifest = make_manifest();
      const encrypted = encrypted_json(manifest);

      vi.mocked(ctx.storage.get)
        .mockRejectedValueOnce(new Error('snapshot pointer not found'))
        .mockResolvedValueOnce(encrypted);
      vi.mocked(ctx.storage.list).mockResolvedValue(['manifests/user@test.com/snap-1.json']);

      const result = await repo.find_by_snapshot(ctx, 'snap-1');
      expect(result).toBeDefined();
      expect(result!.snapshot_id).toBe('snap-1');
    });

    it('returns undefined when no match', async () => {
      vi.mocked(ctx.storage.get).mockRejectedValueOnce(new Error('snapshot pointer not found'));
      vi.mocked(ctx.storage.list).mockResolvedValue([]);

      const result = await repo.find_by_snapshot(ctx, 'nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('find_latest_by_owner', () => {
    it('loads the indexed latest manifest without scanning snapshot history', async () => {
      const manifest = make_manifest({
        snapshot_id: 'snap-new',
        created_at: new Date('2026-06-01T00:00:00Z'),
      });
      const pointer = encrypted_json({
        manifest_key: 'manifests/user@test.com/snap-new.json',
      });
      const encrypted = encrypted_json(manifest);

      vi.mocked(ctx.storage.get).mockResolvedValueOnce(pointer).mockResolvedValueOnce(encrypted);

      const result = await repo.find_latest_by_owner(ctx, 'user@test.com');

      expect(result?.snapshot_id).toBe('snap-new');
      expect(ctx.storage.list).not.toHaveBeenCalled();
      expect(ctx.storage.get).toHaveBeenCalledTimes(2);
    });

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

      const enc_old = encrypted_json(older);
      const enc_new = encrypted_json(newer);

      vi.mocked(ctx.storage.get)
        .mockRejectedValueOnce(new Error('latest pointer not found'))
        .mockResolvedValueOnce(enc_old)
        .mockResolvedValueOnce(enc_new);
      vi.mocked(ctx.storage.list).mockResolvedValue([
        'manifests/user@test.com/snap-old.json',
        'manifests/user@test.com/snap-new.json',
      ]);

      const result = await repo.find_latest_by_owner(ctx, 'user@test.com');
      expect(result).toBeDefined();
      expect(result!.id).toBe('new');
    });

    it('returns undefined for empty mailbox', async () => {
      vi.mocked(ctx.storage.get).mockRejectedValueOnce(new Error('latest pointer not found'));
      vi.mocked(ctx.storage.list).mockResolvedValue([]);

      const result = await repo.find_latest_by_owner(ctx, 'user@test.com');
      expect(result).toBeUndefined();
    });
  });

  describe('list_all_manifests', () => {
    it('bounds parallel manifest downloads', async () => {
      const keys = Array.from(
        { length: 12 },
        (_, index) => `manifests/user@test.com/snap-${index}.json`,
      );
      let in_flight = 0;
      let max_in_flight = 0;
      let started = 0;
      let signal_first_batch!: () => void;
      let signal_all_started!: () => void;
      const first_batch_started = new Promise<void>((resolve) => {
        signal_first_batch = resolve;
      });
      const all_downloads_started = new Promise<void>((resolve) => {
        signal_all_started = resolve;
      });
      const pending_releases: (() => void)[] = [];
      vi.mocked(ctx.storage.list).mockResolvedValue(keys);
      vi.mocked(ctx.storage.get).mockImplementation(
        (key) =>
          new Promise<Buffer>((resolve) => {
            in_flight++;
            started++;
            max_in_flight = Math.max(max_in_flight, in_flight);
            if (in_flight === 8) signal_first_batch();
            if (started === keys.length) signal_all_started();
            pending_releases.push(() => {
              in_flight--;
              const snapshot_id = key.split('/').at(-1)!.replace('.json', '');
              resolve(encrypted_json(make_manifest({ snapshot_id })));
            });
          }),
      );

      const manifests_promise = repo.list_all_manifests(ctx);
      await first_batch_started;

      expect(ctx.storage.get).toHaveBeenCalledTimes(8);
      expect(max_in_flight).toBe(8);
      for (const release of pending_releases.splice(0)) release();

      await all_downloads_started;
      for (const release of pending_releases.splice(0)) release();
      const manifests = await manifests_promise;

      expect(manifests).toHaveLength(keys.length);
      expect(max_in_flight).toBe(8);
    });
  });
});
