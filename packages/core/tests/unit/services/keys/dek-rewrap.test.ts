import { describe, expect, it, vi } from 'vitest';
import { WrongPassphraseError } from '@wisecom/atlas-types';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { DekRewrapService } from '@/services/keys/dek-rewrap.service';
import { DekWrapperMissingError } from '@/services/keys/dek-rewrap.errors';
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
    /** Served by `get` after the first write, to fake a storage that returns the wrong blob. */
    serve_after_write?: Buffer;
    /** Fails the rollback write, so the bucket is left in an unknown state. */
    reject_second_put?: boolean;
  } = {},
): Harness {
  const writer = new EnvelopeKeyService(OLD_PASSPHRASE);
  const dek = writer.generate_dek();
  const objects = new Map<string, Buffer>();
  if (options.seed !== false) objects.set(DEK_KEY, writer.wrap_dek(dek, TENANT));
  let writes = 0;

  const storage = {
    exists: vi.fn(async (key: string) => objects.has(key)),
    get: vi.fn(async (key: string) => {
      // The rollback read must see what the rollback wrote, not the faked blob.
      if (writes === 1 && options.serve_after_write) return options.serve_after_write;
      const found = objects.get(key);
      if (!found) throw new Error(`NoSuchKey: ${key}`);
      return found;
    }),
    put: vi.fn(async (key: string, body: Buffer) => {
      writes += 1;
      if (writes === 2 && options.reject_second_put === true) {
        throw new Error('AccessDenied on the restore');
      }
      objects.set(key, body);
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

  it('fails loudly when the blob read back is not the key that was stored', async () => {
    // Storage accepts the write and serves a different blob back. The read-back check exists for
    // exactly this: the alternative is an unopenable bucket discovered at the next backup.
    const foreign_writer = new EnvelopeKeyService(NEW_PASSPHRASE);
    const foreign = foreign_writer.wrap_dek(foreign_writer.generate_dek(), TENANT);
    const { service } = make_harness({ serve_after_write: foreign });

    await expect(service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE)).rejects.toThrow(
      /Re-wrap verification failed/,
    );
  });

  it('puts the previous wrapper back when verification fails, so the tenant still opens', async () => {
    const foreign_writer = new EnvelopeKeyService(NEW_PASSPHRASE);
    const foreign = foreign_writer.wrap_dek(foreign_writer.generate_dek(), TENANT);
    const { service, objects, dek } = make_harness({ serve_after_write: foreign });

    await expect(service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE)).rejects.toThrow(
      /Re-wrap verification failed/,
    );

    // The only wrapper was overwritten before verification, so without the rollback the tenant
    // would be unopenable with either passphrase.
    const restored = new EnvelopeKeyService(OLD_PASSPHRASE);
    expect(restored.unwrap_dek(objects.get(DEK_KEY)!, TENANT)).toEqual(dek);
  });

  it('names the state of the bucket when the rollback itself fails', async () => {
    const foreign_writer = new EnvelopeKeyService(NEW_PASSPHRASE);
    const foreign = foreign_writer.wrap_dek(foreign_writer.generate_dek(), TENANT);
    const { service } = make_harness({ serve_after_write: foreign, reject_second_put: true });

    await expect(service.rewrap_tenant_dek(TENANT, NEW_PASSPHRASE)).rejects.toThrow(
      /could not be restored/,
    );
  });
});
