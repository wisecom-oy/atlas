import { describe, expect, it, vi } from 'vitest';
import type { ObjectStorage, TenantContext } from '@wisecom/atlas-types';
import {
  lock_run_writes,
  ObjectLockingStorage,
  UNLOCKED_STAGING_UPLOAD,
} from '@/services/shared/run-object-lock';

function make_storage(): ObjectStorage {
  return {
    put: vi.fn(),
    copy: vi.fn(),
    begin_multipart_upload: vi.fn(),
    get: vi.fn().mockResolvedValue(Buffer.from('body')),
    delete: vi.fn(),
    validate_object_lock_policy: vi.fn(),
  } as unknown as ObjectStorage;
}

function make_ctx(storage: ObjectStorage): TenantContext {
  return { tenant_id: 't', storage, destroy: vi.fn() } as unknown as TenantContext;
}

const POLICY = { mode: 'COMPLIANCE' as const, retain_until: '2030-01-01T00:00:00.000Z' };

describe('ObjectLockingStorage', () => {
  it('applies the run policy to puts, copies and multipart uploads', async () => {
    const inner = make_storage();
    const locked = new ObjectLockingStorage(inner, POLICY);

    await locked.put('a', Buffer.from('x'), { m: '1' }, undefined, '"etag"', false);
    await locked.copy('src', 'dst', { m: '1' });
    await locked.begin_multipart_upload('big', { m: '1' });

    expect(inner.put).toHaveBeenCalledWith(
      'a',
      Buffer.from('x'),
      { m: '1' },
      POLICY,
      '"etag"',
      false,
    );
    expect(inner.copy).toHaveBeenCalledWith('src', 'dst', { m: '1' }, POLICY);
    expect(inner.begin_multipart_upload).toHaveBeenCalledWith('big', { m: '1' }, POLICY);
  });

  it('keeps a policy the caller passed explicitly', async () => {
    const inner = make_storage();
    const own = { mode: 'GOVERNANCE' as const, retain_until: '2027-01-01T00:00:00.000Z' };

    await new ObjectLockingStorage(inner, POLICY).put('a', Buffer.from('x'), undefined, own);

    expect(vi.mocked(inner.put).mock.calls[0]?.[3]).toBe(own);
  });

  it('starts a multipart upload without a lock when the staging opt-out is passed', async () => {
    const inner = make_storage();

    await new ObjectLockingStorage(inner, POLICY).begin_multipart_upload(
      'staging',
      undefined,
      UNLOCKED_STAGING_UPLOAD,
    );

    expect(inner.begin_multipart_upload).toHaveBeenCalledWith('staging', undefined);
  });

  it('locks a put or copy that passes the staging opt-out', async () => {
    const inner = make_storage();
    const locked = new ObjectLockingStorage(inner, POLICY);

    await locked.put('a', Buffer.from('x'), undefined, UNLOCKED_STAGING_UPLOAD);
    await locked.copy('src', 'dst', undefined, UNLOCKED_STAGING_UPLOAD);

    expect(vi.mocked(inner.put).mock.calls[0]?.[3]).toBe(POLICY);
    expect(vi.mocked(inner.copy).mock.calls[0]?.[3]).toBe(POLICY);
  });

  it('passes reads and deletes through unchanged', async () => {
    const inner = make_storage();
    const locked = new ObjectLockingStorage(inner, POLICY);

    await expect(locked.get('k')).resolves.toEqual(Buffer.from('body'));
    await locked.delete('k');

    expect(inner.get).toHaveBeenCalledWith('k');
    expect(inner.delete).toHaveBeenCalledWith('k');
  });
});

describe('lock_run_writes', () => {
  it('returns the context unchanged when no retention was requested', async () => {
    const ctx = make_ctx(make_storage());

    await expect(lock_run_writes(ctx, undefined)).resolves.toBe(ctx);
    await expect(lock_run_writes(ctx, { mode: 'COMPLIANCE' })).resolves.toBe(ctx);
    expect(ctx.storage.validate_object_lock_policy).not.toHaveBeenCalled();
  });

  it('validates first, then wraps storage and keeps the rest of the context', async () => {
    const ctx = make_ctx(make_storage());

    const locked = await lock_run_writes(ctx, { retention_days: 7 });

    expect(ctx.storage.validate_object_lock_policy).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'GOVERNANCE' }),
    );
    expect(locked.storage).toBeInstanceOf(ObjectLockingStorage);
    expect(locked.destroy).toBe(ctx.destroy);
    expect(locked.tenant_id).toBe('t');
  });

  it('writes nothing and rejects when the bucket cannot lock', async () => {
    const storage = make_storage();
    vi.mocked(storage.validate_object_lock_policy).mockRejectedValue(new Error('no lock'));

    await expect(lock_run_writes(make_ctx(storage), { retention_days: 7 })).rejects.toThrow(
      'no lock',
    );
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('gives two concurrent runs their own retention', async () => {
    const storage = make_storage();
    const short_run = await lock_run_writes(make_ctx(storage), { retention_days: 7 });
    const long_run = await lock_run_writes(make_ctx(storage), { retention_days: 365 });

    await long_run.storage.put('long', Buffer.from('x'));
    await short_run.storage.put('short', Buffer.from('x'));

    const until = (key: string) =>
      Date.parse(
        vi.mocked(storage.put).mock.calls.find((c) => c[0] === key)?.[3]?.retain_until ?? '',
      );
    expect(until('long') - until('short')).toBeGreaterThan(357 * 86_400_000);
  });
});
