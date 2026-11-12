import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantContextFactory } from '@wisecom/atlas-types';
import {
  NotFoundError,
  ObjectLockRetainedError,
  UnreadableObjectsError,
  UnsupportedFormatVersionError,
} from '@wisecom/atlas-types';
import { read_encrypted_json } from '@/services/shared/stored-json-reader';
import { in_memory_tenant_context } from '@wisecom/atlas-types/testing/in-memory-tenant-context';
import {
  quarantine_unreadable_object,
  type QuarantineTarget,
} from '@/services/quarantine/stored-object-quarantine';
import { stub_owner_leases } from '@wisecom/atlas-types/testing/stub-owner-leases';

const KEY = 'onedrive/manifests/owner-1/od-snap-1000-abc.json';

/** A target that reads JSON at a key and treats anything else there as damaged. */
function json_target(): QuarantineTarget {
  return {
    workload: 'OneDrive',
    lease_workload: 'onedrive',
    accepts: 'OneDrive manifests',
    kind_of: (key) => (key.startsWith('onedrive/manifests/') ? 'manifest' : undefined),
    read: async (ctx, key) => {
      const bytes = await ctx.storage.get(key).catch(() => undefined);
      if (bytes === undefined) return undefined;
      try {
        return JSON.parse(ctx.decrypt(bytes, key).toString('utf-8')) as unknown;
      } catch (err) {
        throw new UnreadableObjectsError('The manifest does not decrypt or parse', [key], {
          cause: err,
        });
      }
    },
  };
}

function factory_for(ctx: TenantContext): TenantContextFactory {
  return { create: async () => ctx } as unknown as TenantContextFactory;
}

function stored(harness: ReturnType<typeof in_memory_tenant_context>, damaged: boolean): Buffer {
  const ciphertext = harness.ctx.encrypt(Buffer.from('{"entries":[]}'), KEY);
  // Flips the last byte. Overwriting it with a constant left 1 run in 256 undamaged.
  const bytes = damaged
    ? Buffer.concat([ciphertext.subarray(0, -1), Buffer.from([ciphertext.at(-1)! ^ 0xff])])
    : ciphertext;
  harness.set_raw(KEY, bytes);
  return bytes;
}

describe('quarantine_unreadable_object (issue #631)', () => {
  it('moves a damaged object under _quarantine/ with its bytes unchanged', async () => {
    const harness = in_memory_tenant_context();
    const bytes = stored(harness, true);

    const result = await quarantine_unreadable_object(
      factory_for(harness.ctx),
      stub_owner_leases().leases,
      json_target(),
      'tenant-1',
      KEY,
    );

    expect(result).toMatchObject({
      storage_key: KEY,
      quarantine_key: `_quarantine/${KEY}`,
      kind: 'manifest',
    });
    expect(result.reason).toContain('does not decrypt or parse');
    expect(harness.raw(KEY)).toBeUndefined();
    expect(harness.raw(`_quarantine/${KEY}`)).toEqual(bytes);
  });

  it('refuses an object that reads cleanly and leaves it in place', async () => {
    const harness = in_memory_tenant_context();
    const bytes = stored(harness, false);

    const move = quarantine_unreadable_object(
      factory_for(harness.ctx),
      stub_owner_leases().leases,
      json_target(),
      't',
      KEY,
    );

    await expect(move).rejects.toBeInstanceOf(NotFoundError);
    await expect(move).rejects.toThrow(/reads cleanly/);
    expect(harness.raw(KEY)).toEqual(bytes);
    expect(harness.keys()).toEqual([KEY]);
  });

  it('refuses a key that holds nothing', async () => {
    const harness = in_memory_tenant_context();

    const move = quarantine_unreadable_object(
      factory_for(harness.ctx),
      stub_owner_leases().leases,
      json_target(),
      't',
      KEY,
    );

    await expect(move).rejects.toThrow(/No OneDrive object exists/);
  });

  it('refuses a key the workload never writes, before opening the tenant', async () => {
    const create = vi.fn();

    const move = quarantine_unreadable_object(
      { create } as unknown as TenantContextFactory,
      stub_owner_leases().leases,
      json_target(),
      't',
      'onedrive/data/owner-1/abc',
    );

    await expect(move).rejects.toThrow(/Only OneDrive manifests can be quarantined/);
    expect(create).not.toHaveBeenCalled();
  });

  it('never overwrites an earlier quarantined copy of the same key', async () => {
    const harness = in_memory_tenant_context();
    harness.set_raw(`_quarantine/${KEY}`, Buffer.from('earlier copy'));
    stored(harness, true);

    const result = await quarantine_unreadable_object(
      factory_for(harness.ctx),
      stub_owner_leases().leases,
      json_target(),
      't',
      KEY,
    );

    expect(result.quarantine_key).toMatch(new RegExp(`^_quarantine/${KEY}\\.\\d+$`));
    expect(harness.raw(`_quarantine/${KEY}`)).toEqual(Buffer.from('earlier copy'));
  });

  it('keeps the copy and reports retention when Object Lock refuses the removal', async () => {
    const harness = in_memory_tenant_context();
    stored(harness, true);
    harness.ctx.storage.delete = async (key) => {
      throw new ObjectLockRetainedError(key);
    };

    const move = quarantine_unreadable_object(
      factory_for(harness.ctx),
      stub_owner_leases().leases,
      json_target(),
      't',
      KEY,
    );

    await expect(move).rejects.toBeInstanceOf(ObjectLockRetainedError);
    expect(harness.raw(`_quarantine/${KEY}`)).toBeDefined();
    expect(harness.raw(KEY)).toBeDefined();
  });

  it('destroys the tenant context it opened', async () => {
    const harness = in_memory_tenant_context();
    stored(harness, true);

    await quarantine_unreadable_object(
      factory_for(harness.ctx),
      stub_owner_leases().leases,
      json_target(),
      't',
      KEY,
    );

    expect(harness.destroyed()).toBe(1);
  });

  it('refuses an object a newer Atlas wrote, which is intact, and leaves it in place', async () => {
    const harness = in_memory_tenant_context();
    const bytes = stored(harness, false);
    const target: QuarantineTarget = {
      ...json_target(),
      read: (ctx, key) => read_encrypted_json(ctx, key, 'OneDrive manifest'),
    };
    harness.ctx.decrypt = () => {
      throw new UnsupportedFormatVersionError('Unsupported content envelope version 2');
    };

    const move = quarantine_unreadable_object(
      factory_for(harness.ctx),
      stub_owner_leases().leases,
      target,
      't',
      KEY,
    );

    await expect(move).rejects.toBeInstanceOf(UnsupportedFormatVersionError);
    expect(harness.raw(KEY)).toEqual(bytes);
    expect(harness.keys()).toEqual([KEY]);
  });

  it.each([
    'onedrive/manifests/../_meta/dek.enc.json',
    'onedrive/manifests/./owner-1.json',
    'onedrive/manifests//od-snap-1000-abc.json',
  ])('refuses %s, whose segments are not plain names, before opening the tenant', async (key) => {
    const create = vi.fn();

    const move = quarantine_unreadable_object(
      { create } as unknown as TenantContextFactory,
      stub_owner_leases().leases,
      json_target(),
      't',
      key,
    );

    await expect(move).rejects.toThrow(/can be quarantined/);
    expect(create).not.toHaveBeenCalled();
  });

  it('leaves the original in place when the copy does not hold the same bytes', async () => {
    const harness = in_memory_tenant_context();
    const bytes = stored(harness, true);
    harness.ctx.storage.copy = async (_source, destination) => {
      harness.set_raw(destination, bytes.subarray(1));
    };

    const move = quarantine_unreadable_object(
      factory_for(harness.ctx),
      stub_owner_leases().leases,
      json_target(),
      't',
      KEY,
    );

    await expect(move).rejects.toThrow(/does not match/);
    expect(harness.raw(KEY)).toEqual(bytes);
  });

  it('runs the workload hook after the move, and not when the move is refused', async () => {
    const harness = in_memory_tenant_context();
    stored(harness, true);
    const after_move = vi.fn().mockResolvedValue(undefined);
    const target = { ...json_target(), after_move };

    await quarantine_unreadable_object(
      factory_for(harness.ctx),
      stub_owner_leases().leases,
      target,
      't',
      KEY,
    );
    await expect(
      quarantine_unreadable_object(
        factory_for(harness.ctx),
        stub_owner_leases().leases,
        target,
        't',
        KEY,
      ),
    ).rejects.toThrow(/No OneDrive object exists/);

    expect(after_move).toHaveBeenCalledTimes(1);
    expect(after_move).toHaveBeenCalledWith(harness.ctx, KEY);
  });
});
