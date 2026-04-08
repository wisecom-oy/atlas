import { timingSafeEqual } from 'node:crypto';
import type { ObjectStorage } from '@/ports/storage/object-storage.port';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';

const DEK_META_KEY = '_meta/dek.enc';

export class DekMismatchError extends Error {
  constructor() {
    super(
      'Target has a different encryption key than the source. ' +
        'Purge the target before replicating from a re-initialized primary.',
    );
    this.name = 'DekMismatchError';
  }
}

/**
 * Validates that source and target share the same DEK.
 * If the target has no dek.enc yet, validation passes (DEK will be copied).
 * Throws DekMismatchError if both sides have a DEK and the raw bytes differ.
 */
export async function validate_dek_match(
  source_storage: ObjectStorage,
  target_storage: ObjectStorage,
  passphrase: string,
  tenant_id: string,
): Promise<void> {
  const target_has_dek = await target_storage.exists(DEK_META_KEY);
  if (!target_has_dek) return;

  const source_wrapped = await source_storage.get(DEK_META_KEY);
  const target_wrapped = await target_storage.get(DEK_META_KEY);

  const key_service = new EnvelopeKeyService(passphrase, tenant_id);
  const source_dek = key_service.unwrap_dek(source_wrapped);
  const target_dek = key_service.unwrap_dek(target_wrapped);

  if (source_dek.length !== target_dek.length || !timingSafeEqual(source_dek, target_dek)) {
    throw new DekMismatchError();
  }
}
