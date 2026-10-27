/** Thrown when a decrypted Outlook manifest names a snapshot other than the key it was read from. */
export class MismatchedManifestError extends Error {
  constructor(
    readonly storage_key: string,
    owner_id: string,
    snapshot_id: string,
  ) {
    super(
      `Outlook manifest at ${storage_key} decrypts to ${owner_id}/${snapshot_id}; ` +
        `refusing to use a manifest that is not the one the key names`,
    );
    this.name = 'MismatchedManifestError';
  }
}

/** Thrown when a decrypted Outlook manifest has a `created_at` that is not a parseable date. */
export class InvalidManifestDateError extends Error {
  constructor(readonly storage_key: string) {
    super(`Invalid created_at in Outlook manifest at ${storage_key}`);
    this.name = 'InvalidManifestDateError';
  }
}
