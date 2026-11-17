import type { TenantContextFactory, TenantStorageContext } from '@wisecom/atlas-types';
import { NotFoundError } from '@wisecom/atlas-types';
import {
  in_memory_versioned_storage,
  type InMemoryVersionedStorage,
} from '@wisecom/atlas-types/testing/in-memory-versioned-storage';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';

export const DEK_KEY = '_meta/dek.enc';
export const OLD_PASSPHRASE = 'the original shared passphrase';
export const NEW_PASSPHRASE = 'the replacement shared passphrase';
export const OTHER_PASSPHRASE = 'a passphrase nobody configured';

/** One tenant's versioned bucket and the data key its first wrapper holds. */
export interface RigTenant {
  readonly bucket: InMemoryVersionedStorage;
  readonly dek: Buffer;
}

/** Several tenant buckets behind one factory, with real leases stored in each bucket. */
export interface KeySetRig {
  readonly tenants: Map<string, RigTenant>;
  readonly factory: TenantContextFactory;
  readonly leases: StorageOwnerLeases;
  /** Wraps the tenant's data key under `passphrase` and stores it as a new version. */
  readonly rewrap_as: (tenant_id: string, passphrase: string) => Promise<void>;
  /** Unwraps the tenant's current wrapper with `passphrase`; undefined when it does not open. */
  readonly opens_with: (tenant_id: string, passphrase: string) => Promise<Buffer | undefined>;
}

/**
 * Seeds each tenant with one wrapper under `passphrase` (`null` seeds a bucket with no key).
 * A tenant not listed has no bucket: the factory rejects it with NotFoundError, as S3 does.
 */
export async function key_set_rig(seeds: Record<string, string | null>): Promise<KeySetRig> {
  const tenants = new Map<string, RigTenant>();
  for (const [tenant_id, passphrase] of Object.entries(seeds)) {
    const bucket = in_memory_versioned_storage();
    const keys = new EnvelopeKeyService(passphrase ?? OLD_PASSPHRASE);
    const dek = keys.generate_dek();
    if (passphrase !== null) await bucket.storage.put(DEK_KEY, await keys.wrap_dek(dek, tenant_id));
    tenants.set(tenant_id, { bucket, dek });
  }

  const factory = {
    create_storage_only: async (tenant_id: string): Promise<TenantStorageContext> => {
      const tenant = tenants.get(tenant_id);
      if (!tenant) throw new NotFoundError(`No bucket for tenant ${tenant_id}`);
      return { tenant_id, storage: tenant.bucket.storage };
    },
  } as unknown as TenantContextFactory;

  return {
    tenants,
    factory,
    leases: new StorageOwnerLeases(),
    rewrap_as: async (tenant_id, passphrase) => {
      const tenant = tenants.get(tenant_id)!;
      const wrapped = await new EnvelopeKeyService(passphrase).wrap_dek(tenant.dek, tenant_id);
      await tenant.bucket.storage.put(DEK_KEY, wrapped);
    },
    opens_with: async (tenant_id, passphrase) => {
      const stored = await tenants.get(tenant_id)!.bucket.storage.get(DEK_KEY);
      try {
        return await new EnvelopeKeyService(passphrase).unwrap_dek(stored, tenant_id);
      } catch {
        return undefined;
      }
    },
  };
}
