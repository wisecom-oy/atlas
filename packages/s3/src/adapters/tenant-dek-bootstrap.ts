import type { EnvelopeKeyService } from '@wisecom/atlas-core';
import { logger } from '@wisecom/atlas-core';
import type { ObjectStorage } from '@wisecom/atlas-types';
import { PreconditionFailedError } from '@/adapters/object-lock.errors';

export const DEK_META_KEY = '_meta/dek.enc';

/** Reads and unwraps the tenant's stored data key. */
export async function load_stored_dek(
  storage: ObjectStorage,
  key_service: EnvelopeKeyService,
  tenant_id: string,
): Promise<Buffer> {
  const wrapped = await storage.get(DEK_META_KEY);
  return key_service.unwrap_dek(wrapped, tenant_id);
}

/**
 * Persists a freshly generated DEK with a create-only conditional write
 * (If-None-Match: *). If a concurrent bootstrap wins the race, the write
 * fails with 412 and the winner's key is adopted. The key is then read
 * back and unwrapped so the DEK in use is always exactly what storage
 * holds - verified before any tenant data is encrypted with it. Unwrap
 * failure here is fatal by design: a DEK is never regenerated over an
 * existing one.
 */
export async function create_dek_exclusively(
  storage: ObjectStorage,
  key_service: EnvelopeKeyService,
  tenant_id: string,
): Promise<Buffer> {
  logger.info(`Generating new encryption key for tenant ${tenant_id}`);
  const dek = key_service.generate_dek();
  const stored_by_this_run = await store_dek_if_absent(storage, key_service, dek, tenant_id);

  const stored_dek = await load_stored_dek(storage, key_service, tenant_id);
  report_adopted_dek(tenant_id, stored_by_this_run, stored_dek.equals(dek));
  return stored_dek;
}

/**
 * Writes the wrapped DEK create-only. Returns false when another run's key was
 * already stored (412), which is the expected outcome of a lost bootstrap race.
 */
async function store_dek_if_absent(
  storage: ObjectStorage,
  key_service: EnvelopeKeyService,
  dek: Buffer,
  tenant_id: string,
): Promise<boolean> {
  const wrapped = await key_service.wrap_dek(dek, tenant_id);
  try {
    await storage.put(DEK_META_KEY, wrapped, undefined, undefined, undefined, true);
    return true;
  } catch (err) {
    if (err instanceof PreconditionFailedError) return false;
    throw err;
  }
}

/**
 * Logs which key a bootstrap ended up using. Losing the race is routine and
 * gets one info line. A key that changed after this run's create-only write
 * succeeded means the backend let a second write through, so that warns.
 */
function report_adopted_dek(
  tenant_id: string,
  stored_by_this_run: boolean,
  stored_matches_generated: boolean,
): void {
  if (!stored_by_this_run) {
    logger.info(`Tenant ${tenant_id}: another run created the data key first; using it`);
    return;
  }
  if (!stored_matches_generated) {
    logger.warn(
      `Tenant ${tenant_id}: the stored data key is not the one this run wrote, so the ` +
        'backend may ignore create-only writes (check with "atlas storage-check"); using the ' +
        'stored key',
    );
  }
}
