import type { ObjectStorage } from '@/ports/storage/object-storage.port';

/**
 * Validates that source and target share the same DEK.
 * Throws DekMismatchError if both sides have a DEK and the raw bytes differ.
 */
export type DekValidationFn = (
  source_storage: ObjectStorage,
  target_storage: ObjectStorage,
  passphrase: string,
  tenant_id: string,
) => Promise<void>;
