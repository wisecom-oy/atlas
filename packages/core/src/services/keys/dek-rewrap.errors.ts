import { ConfigError, StorageError } from '@wisecom/atlas-types';
import { is_precondition_failure } from '@/services/shared/precondition-failure';
import { is_storage_access_denied } from '@/services/shared/storage-access-denied';

/** Thrown when a tenant has no wrapped key to re-wrap. */
export class DekWrapperMissingError extends ConfigError {
  constructor(tenant_id: string, key: string) {
    super(
      `Tenant ${tenant_id} has no wrapped data key at ${key}, so there is nothing to re-wrap. ` +
        `A key is written when the tenant is first backed up.`,
    );
  }
}

/**
 * Thrown when the blob that was just written does not open to the key that was stored.
 *
 * The previous wrapper is gone by this point, so the message has to say what state the bucket is
 * in rather than only what failed.
 */
export class DekRewrapVerificationError extends StorageError {
  constructor(reason: string, cause?: unknown) {
    super(
      `Re-wrap verification failed: ${reason}. The tenant may now be openable only with the ` +
        `passphrase this run was given; do not discard either passphrase until a read succeeds.`,
      cause === undefined ? undefined : { cause },
    );
  }
}

/**
 * Thrown when the re-wrap failed verification and the previous wrapper could not be put back.
 *
 * This is the one state where the operator has to act immediately, so the message says what is
 * in the bucket rather than only what went wrong.
 */
export class DekRewrapRollbackError extends StorageError {
  constructor(key: string, verification_cause: unknown, restore_cause: unknown) {
    const verification = verification_cause instanceof Error ? verification_cause.message : '';
    const restore = restore_cause instanceof Error ? restore_cause.message : String(restore_cause);
    super(
      `Re-wrap failed verification (${verification}) and the previous wrapper could not be ` +
        `restored (${restore}). ${key} is now in an unknown state: do not discard either ` +
        `passphrase, and check whether the object opens with one of them before running anything ` +
        `else against this tenant.`,
      { cause: restore_cause },
    );
  }
}

/**
 * Names a compare-and-swap refusal on the wrapped-key write.
 *
 * The stored wrapper changed between this run reading it and writing it back, which means
 * another re-wrap or a bootstrap is in flight. Overwriting it would discard whatever that run
 * established, so this run stops instead.
 */
export class DekWrapperChangedError extends StorageError {
  constructor(key: string, cause: unknown) {
    super(
      `${key} changed while this re-wrap was running, so the write was refused and nothing was ` +
        `overwritten. Another re-wrap or a first backup is likely in flight against this tenant. ` +
        `Wait for it to finish, confirm which passphrase opens the tenant, then try again.`,
      { cause },
    );
  }
}

/**
 * Classifies a failed wrapped-key write.
 *
 * Two cases are worth naming rather than passing through raw. A compare-and-swap refusal means
 * something else changed the wrapper. A bucket that retains `_meta/dek.enc` under a
 * governance-mode policy refuses the overwrite with a bare access denial, which reads like a
 * credentials problem and is not one (issue #374).
 *
 * Both are recognised by HTTP status, error name, or S3 code, never by message text, so a 500
 * whose message mentions 412 stays a storage failure (issue #658).
 */
export function describe_rewrap_write_failure(key: string, err: unknown): Error {
  if (is_precondition_failure(err)) return new DekWrapperChangedError(key, err);

  const message = err instanceof Error ? err.message : String(err);
  if (!is_storage_access_denied(err)) {
    return err instanceof Error ? err : new Error(message);
  }

  return new StorageError(
    `Could not overwrite ${key}: ${message}. A bucket that holds the wrapped key under an ` +
      `Object Lock retention policy refuses the write until the retention expires, and the ` +
      `credentials in use need s3:PutObject on that key. The stored key is unchanged and the ` +
      `tenant still opens with the passphrase it had.`,
    { cause: err },
  );
}
