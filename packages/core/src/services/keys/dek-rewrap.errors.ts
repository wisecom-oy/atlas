import { ConfigError, StorageError } from '@wisecom/atlas-types';

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
 * Names an Object Lock or permission refusal on the wrapped-key write.
 *
 * A bucket that retains `_meta/dek.enc` under a governance-mode policy refuses the overwrite with
 * a bare access denial, which reads like a credentials problem and is not one (issue #374).
 */
export function describe_rewrap_write_failure(key: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (!/access denied|forbidden|403|object lock|retention|WORM/i.test(message)) {
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
