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
  | 'ATLAS_WRITE_REFUSED'
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

/** How a refused snapshot delete names the chain it protects. Defaults to an Outlook mailbox. */
export interface SnapshotChainWording {
  /** What owns the chain, e.g. `mailbox`, `OneDrive`, `site`. */
  readonly owner: string;
  /** What a snapshot records, e.g. `messages`, `files`. */
  readonly records: string;
  /** The CLI flag that deletes the whole backup when given without `-s`, e.g. `-m`. */
  readonly delete_all_flag: string;
}

const MAILBOX_CHAIN_WORDING: SnapshotChainWording = {
  owner: 'mailbox',
  records: 'messages',
  delete_all_flag: '-m',
};

/**
 * A snapshot delete was refused because newer snapshots are built on it. An Outlook, OneDrive or
 * SharePoint manifest holds only its own run's changes, so the items and removals it recorded
 * exist in no later manifest; deleting it would silently change every newer snapshot (issues
 * #704, #725).
 */
export class SnapshotNotNewestError extends AtlasError {
  constructor(
    readonly snapshot_id: string,
    readonly newer_snapshot_ids: readonly string[],
    options?: { cause?: unknown; wording?: SnapshotChainWording },
  ) {
    const { owner, records, delete_all_flag } = options?.wording ?? MAILBOX_CHAIN_WORDING;
    super(
      'ATLAS_SNAPSHOT_NOT_NEWEST',
      `Refusing to delete snapshot ${snapshot_id}: ${newer_snapshot_ids.length} newer ` +
        `snapshot(s) of this ${owner} include the ${records} it recorded. Delete the newer ` +
        `snapshots first, newest first, or delete the whole ${owner} backup with ${delete_all_flag}.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
  }
}

/** The storage backend failed for a reason that is not permission, retention or absence. */
export class StorageError extends AtlasError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('ATLAS_STORAGE_FAILURE', message, options);
  }
}

/**
 * A create-only write found a different object already stored under its key, and left it in place.
 *
 * A `StorageError` like the refused conditional write it comes from. The key belongs to a snapshot
 * or run, so the next run writes under a new one and a rerun is the remedy.
 */
export class StoredObjectConflictError extends StorageError {
  constructor(
    readonly key: string,
    label: string,
    options?: { cause?: unknown },
  ) {
    super(
      `The ${label} at ${key} already exists and holds a different object. ` +
        'It was not overwritten.',
      options,
    );
  }
}

/**
 * Atlas built a metadata object it could not store safely and refused before writing anything:
 * the object is too large for one JSON document, fails the checks its own reader applies, or does
 * not decrypt back to what was encrypted.
 *
 * A writer-side defect, never storage damage. No object exists at `key`, so it is neither
 * `StorageError` nor `UnreadableObjectsError`, whose remedy is `quarantine`.
 */
export class RefusedWriteError extends AtlasError {
  constructor(
    readonly key: string,
    label: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(
      'ATLAS_WRITE_REFUSED',
      `Refusing to write the ${label} at ${key}: ${reason}. Nothing was written.`,
      options,
    );
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
