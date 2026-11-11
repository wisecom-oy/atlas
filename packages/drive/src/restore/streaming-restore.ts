import { logger } from '@wisecom/atlas-core/utils/logger';

/**
 * Files above this size are restored through an upload session and saved as a streamed archive
 * entry, so their plaintext is never held whole. Smaller ones are decrypted in one buffer.
 */
const STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;

/** Checks whether a file should be decrypted as a stream on restore and save. */
export function should_stream_restore(entry: { size_bytes: number }): boolean {
  return entry.size_bytes > STREAM_THRESHOLD_BYTES;
}

/** Verifies the computed SHA-256 against the manifest entry. */
export function verify_streaming_checksum(
  entry: { checksum?: string | undefined; file_name: string },
  sha256_hex: string,
): boolean {
  if (!entry.checksum) {
    logger.warn(`Missing checksum for ${entry.file_name}; skipping restore`);
    return false;
  }
  if (sha256_hex !== entry.checksum) {
    logger.warn(`Checksum mismatch after streaming decrypt for ${entry.file_name}; skipping`);
    return false;
  }
  return true;
}
