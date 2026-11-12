import { describe, expect, it, vi } from 'vitest';
import type { ObjectStorage, TenantContext } from '@wisecom/atlas-types';
import { StorageError, StoredObjectConflictError } from '@wisecom/atlas-types';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  READER_CHECKS_NOTHING,
  write_encrypted_json,
  type StoredJsonWrite,
} from '@/services/shared/stored-json-writer';

const KEY = 'meta/owner-1/snap-1.json';
const LOCK = { mode: 'GOVERNANCE', retain_until: '2026-04-08T12:00:00.000Z' } as const;

function write_options(overrides: Partial<StoredJsonWrite> = {}): StoredJsonWrite {
  return {
    key: KEY,
    label: 'test manifest',
    reader_check: READER_CHECKS_NOTHING,
    write: 'overwrite',
    confirm_read_back: false,
    ...overrides,
  };
}

/** The context with some storage methods replaced. */
function with_storage(ctx: TenantContext, overrides: Partial<ObjectStorage>): TenantContext {
  return { ...ctx, storage: { ...ctx.storage, ...overrides } };
}

/**
 * Storage whose PUT is sent twice, the way the storage client retries a request whose response was
 * lost: the first attempt stores the object and the second meets it.
 */
function with_retried_put(ctx: TenantContext): TenantContext {
  const put: ObjectStorage['put'] = async (...args) => {
    await ctx.storage.put(...args);
    await ctx.storage.put(...args);
  };
  return with_storage(ctx, { put });
}

describe('create-only write', () => {
  it('sends the create-only condition', async () => {
    const mem = in_memory_tenant_context();
    const put = vi.spyOn(mem.ctx.storage, 'put');

    await write_encrypted_json(mem.ctx, write_options({ write: 'create_only' }), { a: 1 });

    expect(put).toHaveBeenCalledWith(KEY, mem.raw(KEY), undefined, undefined, undefined, true);
  });

  it('refuses a different existing object and leaves it untouched', async () => {
    const mem = in_memory_tenant_context();
    const create_only = write_options({ write: 'create_only' });
    await write_encrypted_json(mem.ctx, create_only, { snapshot: 'first' });
    const first = Buffer.from(mem.raw(KEY)!);

    const second = write_encrypted_json(mem.ctx, create_only, { snapshot: 'second' });

    await expect(second).rejects.toBeInstanceOf(StoredObjectConflictError);
    await expect(second).rejects.toThrow(
      `The test manifest at ${KEY} already exists and holds a different object. ` +
        'It was not overwritten.',
    );
    expect(mem.raw(KEY)!.equals(first)).toBe(true);
  });

  it('refuses the same value encrypted again: only the bytes just sent count', async () => {
    const mem = in_memory_tenant_context();
    const create_only = write_options({ write: 'create_only' });
    await write_encrypted_json(mem.ctx, create_only, { snapshot: 'same' });

    await expect(
      write_encrypted_json(mem.ctx, create_only, { snapshot: 'same' }),
    ).rejects.toBeInstanceOf(StoredObjectConflictError);
  });

  it('accepts the object its own lost-response retry meets', async () => {
    const mem = in_memory_tenant_context();
    const ctx = with_retried_put(mem.ctx);

    await write_encrypted_json(
      ctx,
      write_options({ write: 'create_only', confirm_read_back: true }),
      { snapshot: 'first' },
    );

    expect(JSON.parse(mem.ctx.decrypt(mem.raw(KEY)!, KEY).toString('utf-8'))).toEqual({
      snapshot: 'first',
    });
  });

  it('raises StorageError when the object that refused the write cannot be read', async () => {
    const mem = in_memory_tenant_context();
    mem.set_raw(KEY, Buffer.from('existing'));
    const ctx = with_storage(mem.ctx, {
      get: async () => {
        throw new Error('connection reset');
      },
    });

    const write = write_encrypted_json(ctx, write_options({ write: 'create_only' }), { a: 1 });

    await expect(write).rejects.toBeInstanceOf(StorageError);
    await expect(write).rejects.not.toBeInstanceOf(StoredObjectConflictError);
    await expect(write).rejects.toThrow(KEY);
    expect(mem.raw(KEY)!.toString()).toBe('existing');
  });

  it('passes a storage failure that is not a refused condition through unchanged', async () => {
    const mem = in_memory_tenant_context();
    const outage = new Error('service unavailable');
    const ctx = with_storage(mem.ctx, {
      put: async () => {
        throw outage;
      },
    });

    await expect(
      write_encrypted_json(ctx, write_options({ write: 'create_only' }), { a: 1 }),
    ).rejects.toBe(outage);
  });
});

describe('overwrite', () => {
  it('replaces the existing object with a plain two-argument PUT', async () => {
    const mem = in_memory_tenant_context();
    await write_encrypted_json(mem.ctx, write_options(), { cursor: 1 });
    const put = vi.spyOn(mem.ctx.storage, 'put');

    await write_encrypted_json(mem.ctx, write_options(), { cursor: 2 });

    expect(put).toHaveBeenCalledWith(KEY, mem.raw(KEY));
    expect(JSON.parse(mem.ctx.decrypt(mem.raw(KEY)!, KEY).toString('utf-8'))).toEqual({
      cursor: 2,
    });
  });
});

describe('Object Lock policy', () => {
  it('reaches a create-only PUT unchanged', async () => {
    const mem = in_memory_tenant_context();
    const put = vi.spyOn(mem.ctx.storage, 'put');

    await write_encrypted_json(
      mem.ctx,
      write_options({ write: 'create_only', object_lock_policy: LOCK }),
      { a: 1 },
    );

    expect(put).toHaveBeenCalledWith(KEY, mem.raw(KEY), undefined, LOCK, undefined, true);
  });

  it('reaches an overwriting PUT unchanged', async () => {
    const mem = in_memory_tenant_context();
    const put = vi.spyOn(mem.ctx.storage, 'put');

    await write_encrypted_json(mem.ctx, write_options({ object_lock_policy: LOCK }), { a: 1 });

    expect(put).toHaveBeenCalledWith(KEY, mem.raw(KEY), undefined, LOCK);
  });
});

describe('read-back', () => {
  it('reads the object once and accepts the bytes that were sent', async () => {
    const mem = in_memory_tenant_context();
    const get = vi.spyOn(mem.ctx.storage, 'get');

    await write_encrypted_json(mem.ctx, write_options({ confirm_read_back: true }), { a: 1 });

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(KEY);
  });

  it('raises StorageError naming the key when storage returns different bytes', async () => {
    const mem = in_memory_tenant_context();
    const ctx = with_storage(mem.ctx, {
      put: async (key, data) => {
        const damaged = Buffer.from(data);
        damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 0xff;
        mem.set_raw(key, damaged);
      },
    });

    const write = write_encrypted_json(ctx, write_options({ confirm_read_back: true }), { a: 1 });

    await expect(write).rejects.toBeInstanceOf(StorageError);
    await expect(write).rejects.toThrow(
      `The test manifest at ${KEY} was written, but reading it back returned different bytes`,
    );
  });

  it('raises StorageError when the object is not there to read back', async () => {
    const mem = in_memory_tenant_context();
    const ctx = with_storage(mem.ctx, { put: async () => undefined });

    const write = write_encrypted_json(ctx, write_options({ confirm_read_back: true }), { a: 1 });

    await expect(write).rejects.toBeInstanceOf(StorageError);
    await expect(write).rejects.toThrow(`${KEY} was written but could not be read back`);
  });
});
