import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@wisecom/atlas-types';
import { RefusedWriteError, UnreadableObjectsError } from '@wisecom/atlas-types';
import {
  in_memory_tenant_context,
  type InMemoryTenantContext,
} from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  READER_CHECKS_NOTHING,
  write_encrypted_json,
  write_encrypted_json_text,
  type StoredJsonWrite,
} from '@/services/shared/stored-json-writer';

const KEY = 'meta/owner-1/snap-1.json';

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

function stored_json(mem: InMemoryTenantContext, key: string): unknown {
  return JSON.parse(mem.ctx.decrypt(mem.raw(key)!, key).toString('utf-8'));
}

async function refusal_of(write: Promise<void>): Promise<RefusedWriteError> {
  const err: unknown = await write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(err).toBeInstanceOf(RefusedWriteError);
  return err as RefusedWriteError;
}

describe('write_encrypted_json', () => {
  it('stores the value encrypted under its key', async () => {
    const mem = in_memory_tenant_context();

    await write_encrypted_json(mem.ctx, write_options(), { snapshot_id: 'snap-1', entries: [] });

    expect(mem.keys()).toEqual([KEY]);
    expect(stored_json(mem, KEY)).toEqual({ snapshot_id: 'snap-1', entries: [] });
  });

  it('stores a document the caller serialised itself, byte for byte', async () => {
    const mem = in_memory_tenant_context();

    await write_encrypted_json_text(mem.ctx, write_options(), '{"b":1,"a":2}');

    expect(mem.ctx.decrypt(mem.raw(KEY)!, KEY).toString('utf-8')).toBe('{"b":1,"a":2}');
  });

  it('issues one PUT and no GET when the read-back is off', async () => {
    const mem = in_memory_tenant_context();
    const put = vi.spyOn(mem.ctx.storage, 'put');
    const get = vi.spyOn(mem.ctx.storage, 'get');

    await write_encrypted_json(mem.ctx, write_options(), { a: 1 });

    expect(put).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  describe('serialise', () => {
    it('refuses a value past the JSON string limit and writes nothing', async () => {
      const mem = in_memory_tenant_context();
      const too_large = {
        toJSON: (): never => {
          throw new RangeError('Invalid string length');
        },
      };

      const err = await refusal_of(write_encrypted_json(mem.ctx, write_options(), too_large));

      expect(err.code).toBe('ATLAS_WRITE_REFUSED');
      expect(err.key).toBe(KEY);
      expect(err.message).toContain(KEY);
      expect(err.message).toContain('too large to store as one JSON document');
      expect(err.message).toContain('Nothing was written');
      expect(mem.keys()).toEqual([]);
    });

    it('refuses a value JSON cannot represent', async () => {
      const mem = in_memory_tenant_context();
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const err = await refusal_of(write_encrypted_json(mem.ctx, write_options(), circular));

      expect(err.message).toContain('cannot be serialised as JSON');
      expect(mem.keys()).toEqual([]);
    });

    it('refuses a value with no JSON form', async () => {
      const mem = in_memory_tenant_context();

      const err = await refusal_of(write_encrypted_json(mem.ctx, write_options(), undefined));

      expect(err.message).toContain('no JSON form');
      expect(mem.keys()).toEqual([]);
    });
  });

  describe('reader check', () => {
    it('refuses a value its reader rejects and writes nothing', async () => {
      const mem = in_memory_tenant_context();
      const put = vi.spyOn(mem.ctx.storage, 'put');
      const reader_check = (_parsed: unknown, key: string): void => {
        throw new UnreadableObjectsError('The test manifest is not a manifest', [key]);
      };

      const err = await refusal_of(
        write_encrypted_json(mem.ctx, write_options({ reader_check }), { entries: 'nope' }),
      );

      // A writer-side defect: there is no stored object to quarantine.
      expect(err).not.toBeInstanceOf(UnreadableObjectsError);
      expect(err.message).toContain(KEY);
      expect(err.message).toContain('The test manifest is not a manifest');
      expect(err.message).toContain('Nothing was written');
      expect(err.cause).toBeInstanceOf(UnreadableObjectsError);
      expect(put).not.toHaveBeenCalled();
      expect(mem.keys()).toEqual([]);
    });

    it('shows the reader check what a reader will parse, not the value in memory', async () => {
      const mem = in_memory_tenant_context();
      const reader_check = vi.fn();
      const value = { created_at: new Date('2026-01-15T10:00:00Z'), size: NaN, gone: undefined };

      await write_encrypted_json(mem.ctx, write_options({ reader_check }), value);

      expect(reader_check).toHaveBeenCalledWith(
        { created_at: '2026-01-15T10:00:00.000Z', size: null },
        KEY,
      );
    });

    it('refuses caller-serialised text that is not JSON', async () => {
      const mem = in_memory_tenant_context();

      const err = await refusal_of(write_encrypted_json_text(mem.ctx, write_options(), '{"a":'));

      expect(err.message).toContain('does not parse as JSON');
      expect(mem.keys()).toEqual([]);
    });
  });

  describe('encrypt and decrypt back', () => {
    it('refuses a ciphertext that decrypts to different bytes and writes nothing', async () => {
      const mem = in_memory_tenant_context();
      const ctx: TenantContext = { ...mem.ctx, decrypt: () => Buffer.from('{"a":2}') };

      const err = await refusal_of(write_encrypted_json(ctx, write_options(), { a: 1 }));

      expect(err.message).toContain('decrypts to different bytes');
      expect(mem.keys()).toEqual([]);
    });

    it('refuses a ciphertext that does not decrypt and writes nothing', async () => {
      const mem = in_memory_tenant_context();
      const ctx: TenantContext = {
        ...mem.ctx,
        decrypt: () => {
          throw new Error('Unsupported state or unable to authenticate data');
        },
      };

      const err = await refusal_of(write_encrypted_json(ctx, write_options(), { a: 1 }));

      expect(err.message).toContain('does not decrypt');
      expect(mem.keys()).toEqual([]);
    });
  });
});
