import { timingSafeEqual } from 'node:crypto';
import type { HeldOwnerLease, ObjectStorage } from '@wisecom/atlas-types';
import type { EnvelopeKeyService } from '@/adapters/keystore/envelope-key-service.adapter';
import { parse_dek_blob } from '@/adapters/keystore/dek-blob-codec';
import { logger } from '@/utils/logger';
import {
  DekRewrapVerificationError,
  DekRewrapRollbackError,
  DekWrapperChangedError,
  DekWrapperMissingError,
  describe_rewrap_write_failure,
} from '@/services/keys/dek-rewrap.errors';

export const DEK_KEY = '_meta/dek.enc';

/** The KDF a wrapper used before and after a rewrite. */
export interface WrapperRewrite {
  readonly previous_kdf_id: number;
  readonly kdf_id: number;
}

/** The passphrase a wrapper opens with now, and the one the rewrite wraps it under. */
export interface WrapperKeys {
  readonly current: EnvelopeKeyService;
  readonly next: EnvelopeKeyService;
}

/**
 * Unwraps the stored DEK with `keys.current`, wraps it with `keys.next`, then proves the result
 * opens. The caller holds the tenant lease and owns both key services.
 *
 * @throws WrongPassphraseError when `keys.current` does not open the stored wrapper, before
 *   anything is written.
 */
export async function rewrite_wrapper(
  storage: ObjectStorage,
  lease: HeldOwnerLease,
  tenant_id: string,
  keys: WrapperKeys,
): Promise<WrapperRewrite> {
  if (!(await storage.exists(DEK_KEY))) throw new DekWrapperMissingError(tenant_id, DEK_KEY);

  // Read the ETag with the blob: every write below is a compare-and-swap against it, so a
  // second re-wrap running at the same time is refused rather than silently overwritten.
  //
  // Defence in depth, not the guarantee. An S3-compatible backend that ignores `If-Match`
  // degrades it to a plain overwrite. The classification below is what actually keeps a
  // concurrent run's wrapper safe, and it needs no backend support.
  const { data: stored, etag: stored_etag } = await storage.get_with_etag(DEK_KEY);
  const dek = await keys.current.unwrap_dek(stored, tenant_id);
  try {
    const previous_kdf_id = parse_dek_blob(stored).header.kdf_id;
    const rewrapped = await keys.next.wrap_dek(dek, tenant_id);
    lease.assert_held();
    try {
      await storage.put(DEK_KEY, rewrapped, undefined, undefined, stored_etag);
    } catch (err) {
      throw describe_rewrap_write_failure(DEK_KEY, err);
    }

    const written = await storage.get_with_etag(DEK_KEY);
    await settle_written_wrapper(storage, { stored, written, rewrapped }, keys, tenant_id);
    await assert_rewrap_opens(written.data, keys.next, tenant_id, dek);

    logger.info(`Re-wrapped the data key for ${tenant_id}; no data object was touched`);
    return { previous_kdf_id, kdf_id: parse_dek_blob(written.data).header.kdf_id };
  } finally {
    dek.fill(0);
  }
}

interface WrittenState {
  readonly stored: Buffer;
  readonly written: { readonly data: Buffer; readonly etag: string };
  readonly rewrapped: Buffer;
}

/**
 * Verifies what is actually stored, not what was sent, and decides from that.
 *
 * Rolling back on any verification failure is wrong: the reason the stored blob is not ours may
 * be that a concurrent re-wrap won the race, and overwriting a working wrapper someone else just
 * established is worse than the failure being reported. So the stored blob is classified first,
 * and only a blob nobody can open is replaced.
 */
async function settle_written_wrapper(
  storage: ObjectStorage,
  state: WrittenState,
  keys: WrapperKeys,
  tenant_id: string,
): Promise<void> {
  const verdict = await classify_written_wrapper(
    state.written.data,
    state.rewrapped,
    keys,
    tenant_id,
  );
  if (verdict === 'foreign') throw new DekWrapperChangedError(DEK_KEY, undefined);
  if (verdict === 'unusable') {
    // Nobody can open what is there, so putting the previous wrapper back is strictly an
    // improvement. Conditional on its ETag, so a writer arriving in between still wins.
    await restore_previous_wrapper(storage, state, keys.current, tenant_id);
    throw new DekRewrapVerificationError(
      'the stored wrapper opened with neither passphrase; the previous one was restored',
    );
  }
}

/**
 * Proves the blob that was just written opens to the same key.
 *
 * A wrap that cannot be unwrapped is an unopenable bucket, and the operator would find out at the
 * next backup rather than now.
 */
async function assert_rewrap_opens(
  written: Buffer,
  next: EnvelopeKeyService,
  tenant_id: string,
  expected_dek: Buffer,
): Promise<void> {
  let read_back: Buffer;
  try {
    read_back = await next.unwrap_dek(written, tenant_id);
  } catch (err) {
    throw new DekRewrapVerificationError('the new wrapper could not be unwrapped', err);
  }

  try {
    if (read_back.length !== expected_dek.length || !timingSafeEqual(read_back, expected_dek)) {
      throw new DekRewrapVerificationError('the re-wrapped key is not the key that was stored');
    }
  } finally {
    read_back.fill(0);
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
async function classify_written_wrapper(
  written: Buffer,
  rewrapped: Buffer,
  keys: WrapperKeys,
  tenant_id: string,
): Promise<'ours' | 'foreign' | 'unusable'> {
  if (written.equals(rewrapped)) return 'ours';
  return (await wrapper_opens(written, keys.current, tenant_id)) ||
    (await wrapper_opens(written, keys.next, tenant_id))
    ? 'foreign'
    : 'unusable';
}

/** Whether this key service can unwrap the blob at all. The unwrapped key is zeroed at once. */
export async function wrapper_opens(
  blob: Buffer,
  keys: EnvelopeKeyService,
  tenant_id: string,
): Promise<boolean> {
  try {
    (await keys.unwrap_dek(blob, tenant_id)).fill(0);
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
  state: WrittenState,
  current: EnvelopeKeyService,
  tenant_id: string,
): Promise<void> {
  try {
    await storage.put(DEK_KEY, state.stored, undefined, undefined, state.written.etag);
    (await current.unwrap_dek(await storage.get(DEK_KEY), tenant_id)).fill(0);
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
