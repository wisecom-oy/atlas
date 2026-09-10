import { timingSafeEqual } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type {
  DekRewrapResult,
  DekRewrapUseCase,
  ObjectStorage,
  TenantContextFactory,
} from '@wisecom/atlas-types';
import { ConfigError, TENANT_CONTEXT_FACTORY_TOKEN } from '@wisecom/atlas-types';
import { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { parse_dek_blob } from '@/adapters/keystore/dek-blob-codec';
import { ATLAS_CONFIG_TOKEN, type AtlasConfig } from '@/utils/config';
import { logger } from '@/utils/logger';
import {
  DekRewrapVerificationError,
  DekRewrapRollbackError,
  DekWrapperChangedError,
  DekWrapperMissingError,
  describe_rewrap_write_failure,
} from '@/services/keys/dek-rewrap.errors';

const DEK_KEY = '_meta/dek.enc';

/** Matches the minimum `createAtlasInstance` enforces on `encryptionPassphrase` (issue #45). */
const MIN_PASSPHRASE_BYTES = 14;

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
    if (new_passphrase !== undefined) assert_usable_passphrase(new_passphrase);

    const { storage } = await this._tenant_factory.create_storage_only(tenant_id);
    if (!(await storage.exists(DEK_KEY))) throw new DekWrapperMissingError(tenant_id, DEK_KEY);

    // Read the ETag with the blob: every write below is a compare-and-swap against it, so a
    // second re-wrap running at the same time is refused rather than silently overwritten.
    //
    // Defence in depth, not the guarantee. This is the first conditional write in the codebase,
    // and an S3-compatible backend that ignores `If-Match` degrades it to a plain overwrite. The
    // classification below is what actually keeps a concurrent run's wrapper safe, and it needs
    // no backend support.
    const { data: stored, etag: stored_etag } = await storage.get_with_etag(DEK_KEY);
    const current = new EnvelopeKeyService(this._config.encryption_passphrase);
    const next = new EnvelopeKeyService(new_passphrase ?? this._config.encryption_passphrase);

    try {
      // A wrong current passphrase fails here, before anything is written. `unwrap_dek` raises
      // WrongPassphraseError, which already says what to check.
      const dek = current.unwrap_dek(stored, tenant_id);
      const previous_kdf_id = parse_dek_blob(stored).header.kdf_id;

      const rewrapped = next.wrap_dek(dek, tenant_id);
      try {
        await storage.put(DEK_KEY, rewrapped, undefined, undefined, stored_etag);
      } catch (err) {
        throw describe_rewrap_write_failure(DEK_KEY, err);
      }

      // Verify what is actually stored, not what was sent, and decide from that.
      //
      // Rolling back on any verification failure is wrong: the reason the stored blob is not
      // ours may be that a concurrent re-wrap won the race, and overwriting a working wrapper
      // someone else just established is worse than the failure being reported. So the stored
      // blob is classified first, and only a blob nobody can open is replaced.
      const written = await storage.get_with_etag(DEK_KEY);
      const verdict = classify_written_wrapper(written.data, rewrapped, current, next, tenant_id);

      if (verdict === 'foreign') {
        throw new DekWrapperChangedError(DEK_KEY, undefined);
      }
      if (verdict === 'unusable') {
        // Nobody can open what is there, so putting the previous wrapper back is strictly an
        // improvement. Conditional on its ETag, so a writer arriving in between still wins.
        await restore_previous_wrapper(storage, stored, written.etag, current, tenant_id);
        throw new DekRewrapVerificationError(
          'the stored wrapper opened with neither passphrase; the previous one was restored',
        );
      }

      assert_rewrap_opens(written.data, next, tenant_id, dek);

      logger.info(`Re-wrapped the data key for ${tenant_id}; no data object was touched`);
      return {
        tenant_id,
        previous_kdf_id,
        kdf_id: parse_dek_blob(written.data).header.kdf_id,
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

/**
 * Decides what the blob now at the wrapped-key path actually is.
 *
 * `ours` is the byte-identical copy of what this run wrote. `foreign` opens with one of the two
 * passphrases but is not ours, which means another run wrote it and it must be left alone.
 * `unusable` opens with neither, so it is garbage nobody can back out of and replacing it can
 * only improve matters.
 */
function classify_written_wrapper(
  written: Buffer,
  rewrapped: Buffer,
  current: EnvelopeKeyService,
  next: EnvelopeKeyService,
  tenant_id: string,
): 'ours' | 'foreign' | 'unusable' {
  if (written.equals(rewrapped)) return 'ours';
  return opens(written, current, tenant_id) || opens(written, next, tenant_id)
    ? 'foreign'
    : 'unusable';
}

/** Whether this key service can unwrap the blob at all. */
function opens(blob: Buffer, keys: EnvelopeKeyService, tenant_id: string): boolean {
  try {
    keys.unwrap_dek(blob, tenant_id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts the wrapper that was read at the start back, and proves it still opens.
 *
 * Conditional on the ETag of the unusable blob, so a writer arriving between the classification
 * and this write still wins: whatever they established is newer than what this run knows.
 *
 * Rollback is best effort by nature, because the storage being asked to accept the restore is
 * the storage that just produced an unopenable object. When it fails too, the thrown error
 * names both, since an operator whose only wrapper is in an unknown state needs that first.
 */
async function restore_previous_wrapper(
  storage: ObjectStorage,
  previous: Buffer,
  unusable_etag: string,
  current: EnvelopeKeyService,
  tenant_id: string,
): Promise<void> {
  try {
    await storage.put(DEK_KEY, previous, undefined, undefined, unusable_etag);
    current.unwrap_dek(await storage.get(DEK_KEY), tenant_id);
    logger.warn(
      `Re-wrap produced an unopenable wrapper for ${tenant_id}; restored the previous one, ` +
        `which still opens with the passphrase in use. Nothing changed.`,
    );
  } catch (restore_err) {
    throw new DekRewrapRollbackError(
      DEK_KEY,
      'the stored wrapper opened with neither passphrase',
      restore_err,
    );
  }
}

/**
 * Rejects a new passphrase the SDK would refuse at construction.
 *
 * `createAtlasInstance` enforces 14 UTF-8 bytes, and `rewrapDataKey` reaches the wrap without
 * passing through it: an empty string would otherwise wrap the tenant key under an empty
 * passphrase, which is the one outcome this command must never produce.
 */
function assert_usable_passphrase(passphrase: string): void {
  if (Buffer.byteLength(passphrase, 'utf8') < MIN_PASSPHRASE_BYTES) {
    throw new ConfigError(
      `The new passphrase must contain at least ${MIN_PASSPHRASE_BYTES} UTF-8 bytes. ` +
        `Nothing was changed.`,
    );
  }
}
