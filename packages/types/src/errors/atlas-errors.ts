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
  | 'ATLAS_CONTENT_UNREADABLE'
  | 'ATLAS_FORMAT_UNSUPPORTED'
  | 'ATLAS_KEY_CONFLICT'
  | 'ATLAS_SNAPSHOT_NOT_NEWEST'
  | 'ATLAS_OWNER_BUSY'
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

/**
 * A snapshot delete was refused because newer snapshots are built on it. An Outlook manifest holds
 * only its own run's changes, so the messages and removals it recorded exist in no later manifest;
 * deleting it would silently change every newer snapshot (issue #704).
 */
export class SnapshotNotNewestError extends AtlasError {
  constructor(
    readonly snapshot_id: string,
    readonly newer_snapshot_ids: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(
      'ATLAS_SNAPSHOT_NOT_NEWEST',
      `Refusing to delete snapshot ${snapshot_id}: ${newer_snapshot_ids.length} newer ` +
        `snapshot(s) of this mailbox include the messages it recorded. Delete the newer ` +
        `snapshots first, newest first, or delete the whole mailbox backup with -m.`,
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

/**
 * Stored content exists and cannot be parsed back into the shape Atlas needs.
 *
 * Distinct from `StorageError`: the bytes were fetched, decrypted and checksum-verified, so
 * storage and the key are both fine. Distinct from `WrongPassphraseError` for the same reason.
 * Nothing about retrying changes the answer, which is why it carries its own code rather than
 * borrowing one that reads as transient (issue #411).
 */
export class UnreadableContentError extends AtlasError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ATLAS_CONTENT_UNREADABLE', message, options);
  }
}

/**
 * One or more stored objects an operation needed could not be decrypted, parsed, or identified as
 * the key they sit under, so the operation would give a wrong answer if it went on without them.
 *
 * Names every key so an operator can inspect it and move it aside with `quarantine`. A listing
 * that could still read the rest carries what it read in `partial_result`, so one damaged object
 * never hides the others (issue #631).
 */
export class UnreadableObjectsError<T = unknown> extends UnreadableContentError {
  readonly unreadable_keys: readonly string[];
  /** What the operation could read, for a listing that skipped the damaged objects. */
  readonly partial_result: T | undefined;

  constructor(
    message: string,
    unreadable_keys: readonly string[],
    options?: { cause?: unknown; partial_result?: T | undefined },
  ) {
    super(`${message}: ${unreadable_keys.join(', ')}`, options);
    this.unreadable_keys = unreadable_keys;
    this.partial_result = options?.partial_result;
  }
}

/**
 * Stored content was written by a newer Atlas format version than this build reads. It is intact,
 * so it is not `UnreadableContentError`: the fix is an Atlas upgrade, not a restore.
 */
export class UnsupportedFormatVersionError extends AtlasError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ATLAS_FORMAT_UNSUPPORTED', message, options);
  }
}

/** What another run's lease says about it, as far as an operator needs to decide how long to wait. */
export interface OwnerLeaseHolder {
  /** The operation holding the lease, e.g. `backup`, `restore`, `delete`, `purge`, `rewrap`. */
  readonly operation: string;
  /** Host name and process id of the holder, for finding the process. */
  readonly host: string;
  readonly pid: number;
  /** ISO 8601 UTC. */
  readonly started_at: string;
  /** ISO 8601 UTC. The lease frees itself at this time unless its holder renews it first. */
  readonly expires_at: string;
}

/**
 * Another Atlas run holds the lease on this owner, or on the whole tenant, so this run stopped
 * before writing anything.
 *
 * Retrying once the holder finishes, or once `holder.expires_at` passes, is the remedy. A lease left
 * by a killed process frees itself at its expiry, at most 10 minutes after its last renewal.
 */
export class OwnerBusyError extends AtlasError {
  constructor(
    readonly lease_key: string,
    readonly holder: OwnerLeaseHolder | undefined,
    options?: { cause?: unknown },
  ) {
    super('ATLAS_OWNER_BUSY', describe_busy_owner(lease_key, holder), options);
  }
}

/**
 * This run lost its lease part way through: another run took it over after it expired, or the run
 * could not renew it before its expiry. Every write after the loss was refused, so the state the
 * other run writes is not overwritten. Same code as {@link OwnerBusyError}: another run owns the
 * owner now.
 */
export class OwnerLeaseLostError extends AtlasError {
  constructor(
    readonly lease_key: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(
      'ATLAS_OWNER_BUSY',
      `Lost the run lease ${lease_key} (${reason}); stopped writing so another run's state is not ` +
        'overwritten. Rerun once no other Atlas run is working on this owner.',
      options,
    );
  }
}

function describe_busy_owner(lease_key: string, holder: OwnerLeaseHolder | undefined): string {
  if (holder === undefined) {
    return `Another Atlas run holds the lease ${lease_key}; nothing was written. Retry later.`;
  }
  return (
    `Another Atlas run holds the lease ${lease_key}: ${holder.operation} on ${holder.host} ` +
    `(pid ${holder.pid}), started ${holder.started_at}, lease expires ${holder.expires_at} ` +
    'unless renewed. Nothing was written. Retry after that run finishes or its lease expires.'
  );
}
