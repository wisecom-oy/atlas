import { WrongPassphraseError } from '@wisecom/atlas-types';

/**
 * An object failed its AES-GCM tag check during a drive restore.
 *
 * It carries the same `ATLAS_WRONG_PASSPHRASE` code as a failed data-key unwrap, because AES-GCM
 * cannot tell a wrong key from damaged ciphertext. OneDrive and SharePoint restore abort on the
 * first one (issue #633): a wrong key fails every object, so continuing file by file only writes
 * a partial result whose summary hides the cause.
 */
export class DriveDecryptAuthError extends WrongPassphraseError {
  constructor(file_name: string, options?: { cause?: unknown }) {
    super(
      `AES-GCM authentication failed for ${file_name}: the tenant key does not match this ` +
        `object, or the object was damaged or altered in storage. Restore stopped.`,
      options,
    );
  }
}
