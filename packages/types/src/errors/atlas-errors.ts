/**
 * Stable machine-readable codes. The string values are the contract: they are safe to switch on,
 * to log, and to compare across versions. Prose messages are not, and never were.
 */
export type AtlasErrorCode =
  | 'ATLAS_AUTH_DENIED'
  | 'ATLAS_MAILBOX_NOT_LICENSED'
  | 'ATLAS_NOT_FOUND'
  | 'ATLAS_THROTTLED'
  | 'ATLAS_WRONG_PASSPHRASE'
  | 'ATLAS_OBJECT_LOCK_RETAINED'
  | 'ATLAS_STORAGE_FAILURE'
  | 'ATLAS_CONFIG_INVALID';

/**
 * Base class for every failure Atlas raises on purpose.
 *
 * Consumers branch on `instanceof AtlasError` or on `code`. Before this existed, the only way to
 * tell an unlicensed mailbox from a missing permission was to match on message text, which made
 * every wording change a silent breaking change: the CLI's own diagnostics and the deletion
 * services did exactly that (issue #40).
 */
export class AtlasError extends Error {
  readonly code: AtlasErrorCode;

  constructor(code: AtlasErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** Graph or storage refused the operation for lack of permission or consent. */
export class AuthError extends AtlasError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ATLAS_AUTH_DENIED', message, options);
  }
}

/** The mailbox has no Exchange Online license, so Graph will not serve it. */
export class MailboxNotLicensedError extends AtlasError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ATLAS_MAILBOX_NOT_LICENSED', message, options);
  }
}

/** A snapshot, mailbox, drive, site or object that does not exist. */
export class NotFoundError extends AtlasError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ATLAS_NOT_FOUND', message, options);
  }
}

/** The service throttled the operation and the retry budget was exhausted. */
export class ThrottledError extends AtlasError {
  /** Milliseconds the service asked the caller to wait, when it said. */
  readonly retry_after_ms: number | undefined;

  constructor(message: string, retry_after_ms?: number, options?: { cause?: unknown }) {
    super('ATLAS_THROTTLED', message, options);
    this.retry_after_ms = retry_after_ms;
  }
}

/**
 * The passphrase could not unwrap the data key.
 *
 * Distinct from data corruption on purpose: AES-GCM reports both as one authentication failure,
 * and the raw Node message ("Unsupported state or unable to authenticate data") sent operators
 * looking for a corrupt backup when the real cause was a typo.
 */
export class WrongPassphraseError extends AtlasError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ATLAS_WRONG_PASSPHRASE', message, options);
  }
}

/** The object is under an Object Lock retention or legal hold, so it cannot be deleted yet. */
export class ObjectLockRetainedError extends AtlasError {
  constructor(
    readonly key: string,
    options?: { cause?: unknown },
  ) {
    super(
      'ATLAS_OBJECT_LOCK_RETAINED',
      `Object ${key} is protected by Object Lock retention or a legal hold and was not deleted.`,
      options,
    );
  }
}

/** The storage backend failed for a reason that is not permission, retention or absence. */
export class StorageError extends AtlasError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ATLAS_STORAGE_FAILURE', message, options);
  }
}

/** Configuration is missing or unusable: credentials, endpoint, passphrase, tenant. */
export class ConfigError extends AtlasError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ATLAS_CONFIG_INVALID', message, options);
  }
}
