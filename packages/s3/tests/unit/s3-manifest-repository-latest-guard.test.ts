import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Manifest, TenantContext } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import { S3ManifestRepository } from '@/adapters/s3-manifest-repository.adapter';

const OWNER = 'user@test.com';
const LATEST_POINTER_KEY = `_meta/outlook-manifests/owners/${OWNER}/latest.json`;
const OLDER_AT = new Date('2026-01-15T10:00:00Z');
const MIDDLE_AT = new Date('2026-01-20T10:00:00Z');
const NEWER_AT = new Date('2026-02-01T00:00:00Z');

function manifest_key(snapshot_id: string): string {
  return `manifests/${OWNER}/${snapshot_id}.json`;
}

function snapshot_pointer_key(snapshot_id: string): string {
  return `_meta/outlook-manifests/snapshots/${snapshot_id}.json`;
}

function make_manifest(snapshot_id: string, created_at: Date): Manifest {
  return {
    id: `manifest-${snapshot_id}`,
    tenant_id: 'test-tenant',
    owner_id: OWNER,
    snapshot_id,
    created_at,
    total_objects: 1,
    total_size_bytes: 512,
    delta_links: {},
    entries: [{ object_id: 'msg-1', storage_key: 'data/x', checksum: 'abc', size_bytes: 512 }],
  };
}

/** A pointer body as an Atlas release before issue #741 wrote it: the manifest key only. */
function legacy_pointer_body(snapshot_id: string): Buffer {
  return Buffer.from(JSON.stringify({ manifest_key: manifest_key(snapshot_id) }), 'utf-8');
}

describe('S3ManifestRepository.save latest pointer guard (issue #741)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the pointer on a newer snapshot when a slower run saves an older one, and warns', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest('snap-new', NEWER_AT));
    const pointer_before = Buffer.from(mem.raw(LATEST_POINTER_KEY)!);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await repo.save(mem.ctx, make_manifest('snap-old', OLDER_AT));

    expect(mem.raw(LATEST_POINTER_KEY)!.equals(pointer_before)).toBe(true);
    expect((await repo.find_latest_readable(mem.ctx, OWNER)).manifest?.snapshot_id).toBe(
      'snap-new',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('snap-new');
    expect(message).toContain('snap-old');
  });

  it('still stores the older snapshot, its snapshot pointer, and its summary row', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest('snap-new', NEWER_AT));
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await repo.save(mem.ctx, make_manifest('snap-old', OLDER_AT));

    expect(mem.raw(manifest_key('snap-old'))).toBeDefined();
    expect(mem.raw(snapshot_pointer_key('snap-old'))).toBeDefined();
    expect((await repo.find_by_snapshot(mem.ctx, 'snap-old'))?.snapshot_id).toBe('snap-old');
  });

  it('replaces the pointer when the run is newer than the pointed snapshot, without warning', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest('snap-old', OLDER_AT));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await repo.save(mem.ctx, make_manifest('snap-new', NEWER_AT));

    expect((await repo.find_latest_readable(mem.ctx, OWNER)).manifest?.snapshot_id).toBe(
      'snap-new',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('replaces the pointer when created_at is equal, as before the guard', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest('snap-first', MIDDLE_AT));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await repo.save(mem.ctx, make_manifest('snap-second', MIDDLE_AT));

    expect((await repo.find_latest_readable(mem.ctx, OWNER)).manifest?.snapshot_id).toBe(
      'snap-second',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('writes the pointer when none exists', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();

    await repo.save(mem.ctx, make_manifest('snap-old', OLDER_AT));

    expect((await repo.find_latest_readable(mem.ctx, OWNER)).manifest?.snapshot_id).toBe(
      'snap-old',
    );
  });

  it('replaces a pointer whose body cannot be decrypted', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest('snap-new', NEWER_AT));
    mem.set_raw(LATEST_POINTER_KEY, Buffer.from('not ciphertext'));
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await repo.save(mem.ctx, make_manifest('snap-old', OLDER_AT));

    expect((await repo.find_latest_readable(mem.ctx, OWNER)).manifest?.snapshot_id).toBe(
      'snap-old',
    );
  });

  it('replaces a pointer written before created_at existed', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest('snap-new', NEWER_AT));
    mem.set_raw(
      LATEST_POINTER_KEY,
      mem.ctx.encrypt(legacy_pointer_body('snap-new'), LATEST_POINTER_KEY),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await repo.save(mem.ctx, make_manifest('snap-old', OLDER_AT));

    expect((await repo.find_latest_readable(mem.ctx, OWNER)).manifest?.snapshot_id).toBe(
      'snap-old',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not let a failed read of the pointer block the backup', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest('snap-new', NEWER_AT));
    const failing_read = failing_pointer_read(mem.ctx);
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await repo.save(mem.ctx, make_manifest('snap-old', OLDER_AT));
    failing_read.mockRestore();

    expect((await repo.find_latest_readable(mem.ctx, OWNER)).manifest?.snapshot_id).toBe(
      'snap-old',
    );
  });

  it('compares from the pointer alone: the manifest it names is not read', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest('snap-new', NEWER_AT));
    const get = vi.spyOn(mem.ctx.storage, 'get');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await repo.save(mem.ctx, make_manifest('snap-old', OLDER_AT));

    expect(get.mock.calls).toEqual([[manifest_key('snap-old')], [LATEST_POINTER_KEY]]);
  });

  it('lets an older run take latest back after the newest snapshot was deleted', async () => {
    const mem = in_memory_tenant_context();
    const repo = new S3ManifestRepository();
    await repo.save(mem.ctx, make_manifest('snap-old', OLDER_AT));
    await repo.save(mem.ctx, make_manifest('snap-new', NEWER_AT));

    // The deletion path (DeletionService.delete_snapshot) removes the manifest, its snapshot
    // pointer and latest.json. It never writes an older pointer, and it does not call save().
    mem.remove(manifest_key('snap-new'));
    mem.remove(snapshot_pointer_key('snap-new'));
    mem.remove(LATEST_POINTER_KEY);
    expect((await repo.find_latest_readable(mem.ctx, OWNER)).manifest?.snapshot_id).toBe(
      'snap-old',
    );

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await repo.save(mem.ctx, make_manifest('snap-middle', MIDDLE_AT));

    expect((await repo.find_latest_readable(mem.ctx, OWNER)).manifest?.snapshot_id).toBe(
      'snap-middle',
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

/** Makes the latest pointer read fail with a transient error and leaves every other read alone. */
function failing_pointer_read(ctx: TenantContext): MockInstance {
  const original_get = ctx.storage.get.bind(ctx.storage);
  return vi.spyOn(ctx.storage, 'get').mockImplementation(async (key: string) => {
    if (key === LATEST_POINTER_KEY) throw new Error('connection reset');
    return original_get(key);
  });
}
