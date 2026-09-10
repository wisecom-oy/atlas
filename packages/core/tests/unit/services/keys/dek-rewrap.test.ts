import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WrongPassphraseError } from '@wisecom/atlas-types';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { DekRewrapService } from '@/services/keys/dek-rewrap.service';
import { DekWrapperChangedError, DekWrapperMissingError } from '@/services/keys/dek-rewrap.errors';
import type { AtlasConfig } from '@/utils/config';

/**
 * Issue #374. Nothing re-wrapped an existing DEK, so a leaked passphrase was permanent and the
 * KDF parameters a tenant was bootstrapped with were the ones it kept. The DEK must come through
 * byte-identical, because a new one over an existing bucket makes every stored object
 * unreadable.
 */

const TENANT = 'tenant-1';
const OLD_PASSPHRASE = 'the-original-passphrase';
const NEW_PASSPHRASE = 'a-different-passphrase';
const DEK_KEY = '_meta/dek.enc';

function make_config(passphrase: string): AtlasConfig {
  return {
    tenant_id: TENANT,
    client_id: 'client-1',
    client_secret: 'secret-1',
    s3_endpoint: 'http://primary:9000',
    s3_access_key: 'access',
    s3_secret_key: 'secret',
    s3_region: 'us-east-1',
    encryption_passphrase: passphrase,
  };
}

interface Harness {
  service: DekRewrapService;
  objects: Map<string, Buffer>;
  dek: Buffer;
}

/** A bucket holding one wrapped DEK, written with `OLD_PASSPHRASE`. */
function make_harness(
  options: {
    config_passphrase?: string;
    seed?: boolean;
    /**
     * Stored instead of the bytes the first write sends, which is how a concurrent writer or a
     * backend that mangles a write looks from the caller's side. ETags stay consistent with what
     * is stored, the way S3 behaves.
     */
    store_instead?: Buffer;
    /** Stored right after this run's first read, so its compare-and-swap must fail. */
    rival_after_read?: Buffer;
    /** Fails the rollback write, so the bucket is left in an unknown state. */
    reject_second_put?: boolean;
  } = {},
): Harness {
  const writer = new EnvelopeKeyService(OLD_PASSPHRASE);
  const dek = writer.generate_dek();
  const objects = new Map<string, Buffer>();
  if (options.seed !== false) objects.set(DEK_KEY, writer.wrap_dek(dek, TENANT));
  let writes = 0;
  let reads = 0;

  const etag_of = (body: Buffer): string => `"${createHash('md5').update(body).digest('hex')}"`;
  const storage = {
    exists: vi.fn(async (key: string) => objects.has(key)),
    get: vi.fn(async (key: string) => {
      const found = objects.get(key);
      if (!found) throw new Error(`NoSuchKey: ${key}`);
      return found;
    }),
    get_with_etag: vi.fn(async (key: string) => {
      const data = objects.get(key);
      if (!data) throw new Error(`NoSuchKey: ${key}`);
      const result = { data, etag: etag_of(data) };
      // A rival write landing immediately after this run's read is what the compare-and-swap on
      // the following put exists to catch.
      if (reads === 0 && options.rival_after_read) objects.set(key, options.rival_after_read);
      reads += 1;
      return result;
    }),
    put: vi.fn(async (key: string, body: Buffer, _m?: unknown, _l?: unknown, if_match?: string) => {
      const held = objects.get(key);
      if (if_match !== undefined && held && if_match !== etag_of(held)) {
        const conflict = new Error(`Conditional write failed for key ${key}`);
        conflict.name = 'PreconditionFailedError';
        throw conflict;
      }
      writes += 1;
      if (writes === 2 && options.reject_second_put === true) {
        throw new Error('AccessDenied on the restore');
      }
      objects.set(key, writes === 1 && options.store_instead ? options.store_instead : body);
    }),
  };

  const factory = {
    create_storage_only: vi.fn().mockResolvedValue({ tenant_id: TENANT, storage }),
    create: vi.fn(),
    create_readonly: vi.fn(),
  } as unknown as TenantContextFactory;

  return {
    service: new DekRewrapService(
      factory,
      make_config(options.config_passphrase ?? OLD_PASSPHRASE),
    ),
    objects,
    dek,
  };
}

describe('re-wrapping a tenant data key', () => {
  it('round-trips: the new passphrase opens the same key', async () => {
    const { service, objects, dek } = make_harness();

    const result = await service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE);

    expect(result.passphrase_changed).toBe(true);
    const reader = new EnvelopeKeyService(NEW_PASSPHRASE);
    expect(reader.unwrap_dek(objects.get(DEK_KEY)!, TENANT)).toEqual(dek);
  });

  it('leaves the old passphrase unable to open it', async () => {
    const { service, objects } = make_harness();

    await service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE);

    const stale = new EnvelopeKeyService(OLD_PASSPHRASE);
    expect(() => stale.unwrap_dek(objects.get(DEK_KEY)!, TENANT)).toThrow(WrongPassphraseError);
  });

  it('re-wraps under the configured passphrase with a fresh salt when none is given', async () => {
    const { service, objects, dek } = make_harness();
    const before = objects.get(DEK_KEY)!;

    const result = await service.rewrap_tenant_dek(TENANT);

    expect(result.passphrase_changed).toBe(false);
    const after = objects.get(DEK_KEY)!;
    // A different blob, because the salt is fresh, holding the same key.
    expect(after.equals(before)).toBe(false);
    expect(new EnvelopeKeyService(OLD_PASSPHRASE).unwrap_dek(after, TENANT)).toEqual(dek);
  });

  it('refuses, and writes nothing, when the current passphrase is wrong', async () => {
    const { service, objects } = make_harness({ config_passphrase: 'not-the-passphrase' });
    const before = objects.get(DEK_KEY)!;

    await expect(service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE)).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    expect(objects.get(DEK_KEY)).toBe(before);
  });

  it('refuses when the tenant has no wrapped key', async () => {
    const { service } = make_harness({ seed: false });

    await expect(service.rewrap_tenant_dek(TENANT)).rejects.toBeInstanceOf(DekWrapperMissingError);
  });

  it('rejects a new passphrase the SDK would refuse at construction', async () => {
    const { service, objects } = make_harness();
    const before = objects.get(DEK_KEY)!;

    // `createAtlasInstance` enforces 14 bytes; rewrapDataKey reaches the wrap without it, so an
    // empty string would otherwise wrap the tenant key under an empty passphrase.
    await expect(service.rewrap_tenant_dek(TENANT, '')).rejects.toThrow(/at least 14/);
    expect(objects.get(DEK_KEY)).toBe(before);
  });

  it('leaves a concurrent run\u2019s wrapper alone rather than reverting it', async () => {
    // Someone else's valid wrapper is what is stored when this run reads back. Rolling back
    // here would silently undo their rotation and leave them believing it took.
    const rival = new EnvelopeKeyService(NEW_PASSPHRASE);
    const rival_blob = rival.wrap_dek(rival.generate_dek(), TENANT);
    const { service, objects } = make_harness({ store_instead: rival_blob });

    await expect(service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE)).rejects.toBeInstanceOf(
      DekWrapperChangedError,
    );
    expect(objects.get(DEK_KEY)).toBe(rival_blob);
  });

  it('restores the previous wrapper when what landed opens with neither passphrase', async () => {
    // A mangled write: nobody can back out of this, so putting the old wrapper back is strictly
    // an improvement over leaving the tenant unopenable.
    const { service, objects, dek } = make_harness({ store_instead: Buffer.from('not a wrapper') });

    await expect(service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE)).rejects.toThrow(
      /opened with neither passphrase/,
    );

    const restored = new EnvelopeKeyService(OLD_PASSPHRASE);
    expect(restored.unwrap_dek(objects.get(DEK_KEY)!, TENANT)).toEqual(dek);
  });

  it('names the state of the bucket when the restore itself fails', async () => {
    const { service } = make_harness({
      store_instead: Buffer.from('not a wrapper'),
      reject_second_put: true,
    });

    await expect(service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE)).rejects.toThrow(
      /could not be restored/,
    );
  });

  it('refuses the write when the wrapper changed between the read and the write', async () => {
    const rival = new EnvelopeKeyService(NEW_PASSPHRASE);
    const rival_blob = rival.wrap_dek(rival.generate_dek(), TENANT);
    const { service, objects } = make_harness({ rival_after_read: rival_blob });

    // The read saw the original blob, so the unwrap succeeds; the compare-and-swap on the write
    // is what catches that the object moved underneath this run.
    await expect(service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE)).rejects.toBeInstanceOf(
      DekWrapperChangedError,
    );
    expect(objects.get(DEK_KEY)).toBe(rival_blob);
  });
});
