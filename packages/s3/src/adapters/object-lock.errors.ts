export class ObjectLockVersioningDisabledError extends Error {
  constructor(bucket: string) {
    super(
      `Immutability requested, but bucket versioning is disabled for ${bucket}. ` +
        'Enable bucket versioning and Object Lock, or run backup without retention.',
    );
    this.name = 'ObjectLockVersioningDisabledError';
  }
}

export class ObjectLockUnsupportedError extends Error {
  constructor(bucket: string) {
    super(
      `Immutability requested, but Object Lock is not supported or not enabled for bucket ${bucket}.`,
    );
    this.name = 'ObjectLockUnsupportedError';
  }
}

export class ObjectLockModeRejectedError extends Error {
  constructor(bucket: string, mode: string, cause?: unknown) {
    const cause_text = cause instanceof Error ? ` (${cause.message})` : '';
    super(`Backend rejected Object Lock mode ${mode} for bucket ${bucket}.${cause_text}`);
    this.name = 'ObjectLockModeRejectedError';
  }
}

/** Thrown when a conditional put fails (ETag mismatch or create-only key already exists). */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(
      `Conditional write failed for key ${key} — precondition not met (412 Precondition Failed)`,
    );
    this.name = 'PreconditionFailedError';
  }
}
