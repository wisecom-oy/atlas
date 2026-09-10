import { timingSafeEqual } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type { DekRewrapResult, DekRewrapUseCase, TenantContextFactory } from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { parse_dek_blob } from '@/adapters/keystore/dek-blob-codec';
import { ATLAS_CONFIG_TOKEN, type AtlasConfig } from '@/utils/config';
import { logger } from '@/utils/logger';
import {
  DekRewrapVerificationError,
  DekWrapperMissingError,
  describe_rewrap_write_failure,
} from '@/services/keys/dek-rewrap.errors';

const DEK_KEY = '_meta/dek.enc';

/**
 * Re-wraps a tenant's stored DEK under a new passphrase, new KDF parameters, or both.
 *
 * The DEK itself never changes, so no data object is touched and every existing snapshot stays
 * readable. That also bounds what this is worth: it rotates the wrapper, not the key. Anyone who
 * already holds the DEK or the plaintext is unaffected, and the only answer to that is
 * re-encrypting the bucket (issue #374).
 */
@injectable()
export class DekRewrapService implements DekRewrapUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(ATLAS_CONFIG_TOKEN) private readonly _config: AtlasConfig,
  ) {}

  /** Unwraps with the current passphrase, wraps with the next, then proves the result opens. */
  async rewrap_tenant_dek(tenant_id: string, new_passphrase?: string): Promise<DekRewrapResult> {
    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    if (!(await storage.exists(DEK_KEY))) throw new DekWrapperMissingError(tenant_id, DEK_KEY);

    const stored = await storage.get(DEK_KEY);
    const current = new EnvelopeKeyService(this._config.encryption_passphrase);
    const next = new EnvelopeKeyService(new_passphrase ?? this._config.encryption_passphrase);

    try {
      // A wrong current passphrase fails here, before anything is written. `unwrap_dek` raises
      // WrongPassphraseError, which already says what to check.
      const dek = current.unwrap_dek(stored, tenant_id);
      const previous_kdf_id = parse_dek_blob(stored).header.kdf_id;

      const rewrapped = next.wrap_dek(dek, tenant_id);
      try {
        await storage.put(DEK_KEY, rewrapped);
      } catch (err) {
        throw describe_rewrap_write_failure(DEK_KEY, err);
      }

      assert_rewrap_opens(await storage.get(DEK_KEY), next, tenant_id, dek);

      logger.info(`Re-wrapped the data key for ${tenant_id}; no data object was touched`);
      return {
        tenant_id,
        previous_kdf_id,
        kdf_id: parse_dek_blob(rewrapped).header.kdf_id,
        passphrase_changed: new_passphrase !== undefined,
      };
    } finally {
      current.destroy();
      next.destroy();
    }
  }
}

/**
 * Proves the blob that was just written opens to the same key.
 *
 * `create_dek_exclusively` reads back on bootstrap for this reason, and it matters more here: a
 * wrap that cannot be unwrapped is an unopenable bucket, and the operator would find out at the
 * next backup rather than now.
 */
function assert_rewrap_opens(
  written: Buffer,
  next: EnvelopeKeyService,
  tenant_id: string,
  expected_dek: Buffer,
): void {
  let read_back: Buffer;
  try {
    read_back = next.unwrap_dek(written, tenant_id);
  } catch (err) {
    throw new DekRewrapVerificationError('the new wrapper could not be unwrapped', err);
  }

  if (read_back.length !== expected_dek.length || !timingSafeEqual(read_back, expected_dek)) {
    throw new DekRewrapVerificationError('the re-wrapped key is not the key that was stored');
  }
}
