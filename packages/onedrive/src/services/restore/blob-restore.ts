import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_gcm_auth_failure } from '@wisecom/atlas-core/utils/gcm-auth';
import type { StoredBlobRef, TenantContext } from '@wisecom/atlas-types';
import {
  should_stream_restore,
  stream_decrypt_from_storage,
  verify_streaming_checksum,
} from '@wisecom/atlas-drive/restore/streaming-restore';
import {
  OneDriveDecryptAuthError,
  plaintext_sha256_equals_expected,
} from '@/services/restore/restore-integrity';

/**
 * Fetches and decrypts one stored blob, or undefined when it cannot be trusted.
 *
 * Returning undefined rather than throwing lets a bulk restore skip one bad
 * object and report it, instead of losing the whole run. An AES-GCM auth
 * failure is thrown instead of swallowed, so a caller can tell "wrong key or
 * tampered ciphertext" from "one unreadable object" rather than reporting the
 * first as the second (issue #76).
 */
export async function download_and_decrypt_blob(
  ctx: TenantContext,
  ref: StoredBlobRef,
): Promise<Buffer | undefined> {
  if (!ref.storage_key) return undefined;
  return should_stream_restore(ref)
    ? stream_download_and_decrypt(ctx, ref)
    : buffered_download_and_decrypt(ctx, ref);
}

/** Streaming path: avoids holding the full ciphertext in memory for large files. */
async function stream_download_and_decrypt(
  ctx: TenantContext,
  ref: StoredBlobRef,
): Promise<Buffer | undefined> {
  try {
    const { content, sha256_hex } = await stream_decrypt_from_storage(ctx, ref.storage_key!);
    if (!verify_streaming_checksum(ref, sha256_hex)) return undefined;
    return content;
  } catch (err) {
    if (is_gcm_auth_failure(err)) {
      throw new OneDriveDecryptAuthError(`AES-GCM authentication failed for ${ref.file_name}`, {
        cause: err,
      });
    }
    logger.warn(
      `Streaming decrypt failed for ${ref.file_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/** Buffered path: simple and safe for small files at or below the stream threshold. */
async function buffered_download_and_decrypt(
  ctx: TenantContext,
  ref: StoredBlobRef,
): Promise<Buffer | undefined> {
  let encrypted: Buffer;
  try {
    encrypted = await ctx.storage.get(ref.storage_key!);
  } catch (err) {
    logger.warn(
      `Missing or unreadable blob for ${ref.file_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  try {
    const content = ctx.decrypt(encrypted);
    if (!ref.checksum || !plaintext_sha256_equals_expected(content, ref.checksum)) {
      logger.warn(
        ref.checksum
          ? `Checksum mismatch after decrypt for ${ref.file_name}; skipping restore`
          : `Missing checksum for ${ref.file_name}; skipping restore`,
      );
      return undefined;
    }
    return content;
  } catch (err) {
    if (is_gcm_auth_failure(err)) {
      throw new OneDriveDecryptAuthError(`AES-GCM authentication failed for ${ref.file_name}`, {
        cause: err,
      });
    }
    logger.warn(
      `Failed to decrypt ${ref.file_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
