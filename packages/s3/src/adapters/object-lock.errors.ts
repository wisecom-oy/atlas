import { AtlasError, ConfigError, StorageError } from '@wisecom/atlas-types';

/**
 * These are storage-configuration failures, so they carry `ATLAS_CONFIG_INVALID` or
 * `ATLAS_STORAGE_FAILURE` and are reachable as {@link AtlasError} by an SDK consumer that only
 * wants to know which category it is in (issue #40). The classes stay, because the operator-facing
 * remediation text differs per case and is the point of each one.
 */
export class ObjectLockVersioningDisabledError extends ConfigError {
  constructor(bucket: string) {
    super(
      `Immutability requested, but bucket versioning is disabled for ${bucket}. ` +
        'Enable bucket versioning and Object Lock, or run backup without retention.',
    );
  }
}

export class ObjectLockUnsupportedError extends ConfigError {
  constructor(bucket: string) {
    super(
      `Immutability requested, but Object Lock is not supported or not enabled for bucket ${bucket}.`,
    );
  }
}

export class ObjectLockModeRejectedError extends ConfigError {
  constructor(bucket: string, mode: string, cause?: unknown) {
    const cause_text = cause instanceof Error ? ` (${cause.message})` : '';
    super(`Backend rejected Object Lock mode ${mode} for bucket ${bucket}.${cause_text}`, {
      cause,
    });
  }
}

/** Thrown when a conditional put fails (ETag mismatch or create-only key already exists). */
export class PreconditionFailedError extends StorageError {
  constructor(key: string) {
    super(
      `Conditional write failed for key ${key} -- precondition not met (412 Precondition Failed)`,
    );
  }
}
