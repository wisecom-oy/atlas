import { UnreadableObjectsError } from '@wisecom/atlas-types';

/**
 * Thrown when a decrypted Outlook manifest names a snapshot other than the key it was read from.
 * Unreadable content: a listing skips it and names the key rather than failing (issue #631).
 */
export class MismatchedManifestError extends UnreadableObjectsError {
  constructor(
    readonly storage_key: string,
    owner_id: string,
    snapshot_id: string,
  ) {
    super(
      `Outlook manifest decrypts to ${owner_id}/${snapshot_id}; ` +
        `refusing to use a manifest that is not the one the key names`,
      [storage_key],
    );
  }
}

/** Thrown when a decrypted Outlook manifest has a `created_at` that is not a parseable date. */
export class InvalidManifestDateError extends UnreadableObjectsError {
  constructor(readonly storage_key: string) {
    super('Invalid created_at in Outlook manifest', [storage_key]);
  }
}

/** Thrown when a decrypted Outlook manifest lacks the fields every manifest carries. */
export class MalformedManifestError extends UnreadableObjectsError {
  constructor(readonly storage_key: string) {
    super('Outlook manifest is not a manifest: required fields are missing', [storage_key]);
  }
}
