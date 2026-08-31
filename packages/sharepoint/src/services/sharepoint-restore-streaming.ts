import { logger } from '@wisecom/atlas-core/utils/logger';

export {
  stream_decrypt_from_storage,
  type StreamDecryptResult,
} from '@wisecom/atlas-core/services/shared/stream-decrypt';

/** Files above this size are decrypted as a stream rather than buffered whole. */
const STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;

/** Checks whether a file should use stream-based restore. */
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
