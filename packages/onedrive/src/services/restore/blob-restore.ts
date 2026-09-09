import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_gcm_auth_failure } from '@wisecom/atlas-core/utils/gcm-auth';
import { stream_verified_plaintext } from '@wisecom/atlas-core/services/shared/stream-decrypt';
import type {
  LargeFileContent,
  StoredBlobRef,
  StreamedFileContent,
  TenantContext,
} from '@wisecom/atlas-types';
import { should_stream_restore } from '@wisecom/atlas-drive/restore/streaming-restore';
import {
  OneDriveDecryptAuthError,
  plaintext_sha256_equals_expected,
} from '@/services/restore/restore-integrity';

/**
 * Fetches one stored blob for restore, or undefined when it cannot be trusted.
 *
 * A file past the streaming threshold is handed back as a verified stream rather than a buffer, so
 * restoring it costs two upload chunks of memory instead of the whole plaintext (issue #343). The
 * shape is the caller's upload decision too: a stream is only produced for a file the small-file
 * upload could not take anyway.
 *
 * Returning undefined rather than throwing lets a bulk restore skip one bad object and report it,
 * instead of losing the whole run. An AES-GCM auth failure is thrown instead of swallowed, so a
 * caller can tell "wrong key or tampered ciphertext" from "one unreadable object" rather than
 * reporting the first as the second (issue #76).
 */
export async function download_and_decrypt_blob(
  ctx: TenantContext,
  ref: StoredBlobRef,
): Promise<LargeFileContent | undefined> {
  if (!ref.storage_key) return undefined;
  return should_stream_restore(ref)
    ? verified_blob_stream(ctx, ref)
    : buffered_download_and_decrypt(ctx, ref);
}

/**
 * Streaming path: the plaintext is never held whole, so the checksum can only be compared once the
 * last chunk has been produced.
 *
 * The upload the stream feeds must therefore not commit until the iteration ends, which the Graph
 * upload session guarantees by holding its final chunk back. A mismatch or a failed tag then
 * abandons the session rather than leaving a wrong file in the user's drive.
 */
function verified_blob_stream(
  ctx: TenantContext,
  ref: StoredBlobRef,
): StreamedFileContent | undefined {
  if (!ref.checksum) {
    logger.warn(`Missing checksum for ${ref.file_name}; skipping restore`);
    return undefined;
  }
  return {
    chunks: authenticated_chunks(ctx, ref.storage_key!, ref.checksum, ref.file_name),
    total_bytes: ref.size_bytes,
  };
}

/** Yields verified plaintext, reporting a failed tag as the operator-visible error it is. */
async function* authenticated_chunks(
  ctx: TenantContext,
  storage_key: string,
  expected_checksum: string,
  file_name: string,
): AsyncGenerator<Buffer> {
  try {
    yield* stream_verified_plaintext(ctx, storage_key, expected_checksum, file_name);
  } catch (err) {
    if (is_gcm_auth_failure(err)) {
      throw new OneDriveDecryptAuthError(`AES-GCM authentication failed for ${file_name}`, {
        cause: err,
      });
    }
    throw err;
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
