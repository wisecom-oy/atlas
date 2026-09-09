/**
 * Fetching and decrypting a manifest entry's stored blob for restore.
 *
 * Two paths exist for the same job: files at or above the streaming threshold
 * are decrypted in chunks, everything else is buffered. Both verify the
 * plaintext SHA-256 against the manifest before the content is handed back, so
 * a corrupted or truncated blob is skipped rather than uploaded over a good
 * file. A failed authentication tag is raised as `SharePointDecryptAuthError`
 * because it means the wrong key or tampered ciphertext -- an operator-visible
 * condition, not a per-file hiccup to log and move past.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  LargeFileContent,
  StoredBlobRef,
  StreamedFileContent,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_gcm_auth_failure } from '@wisecom/atlas-core/utils/gcm-auth';
import { stream_verified_plaintext } from '@wisecom/atlas-core/services/shared/stream-decrypt';
import { should_stream_restore } from '@wisecom/atlas-drive/restore/streaming-restore';

/** Thrown when ciphertext decrypts with AES-GCM but fails the authentication tag check. */
export class SharePointDecryptAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SharePointDecryptAuthError';
  }
}

/**
 * Returns the entry's content for restore, or undefined when it cannot be restored.
 *
 * A file past the streaming threshold comes back as a verified stream rather than a buffer, so
 * restoring it costs two upload chunks of memory instead of the whole plaintext (issue #343). The
 * shape doubles as the upload decision: only a file too large for the small-file upload streams.
 */
export async function download_and_decrypt(
  ctx: TenantContext,
  entry: StoredBlobRef,
): Promise<LargeFileContent | undefined> {
  if (!entry.storage_key) return undefined;

  return should_stream_restore(entry)
    ? verified_blob_stream(ctx, entry)
    : buffered_download_and_decrypt(ctx, entry);
}

/**
 * Streaming path: the plaintext is never held whole, so the checksum is only comparable once the
 * last chunk has been produced.
 *
 * The upload it feeds must therefore not commit until the iteration ends, which the Graph upload
 * session guarantees by holding its final chunk back. A mismatch or a failed tag then abandons the
 * session instead of leaving a wrong file in the library.
 */
function verified_blob_stream(
  ctx: TenantContext,
  entry: StoredBlobRef,
): StreamedFileContent | undefined {
  if (!entry.checksum) {
    logger.warn(`Missing checksum for ${entry.file_name}; skipping restore`);
    return undefined;
  }
  return {
    chunks: authenticated_chunks(ctx, entry.storage_key!, entry.checksum, entry.file_name),
    total_bytes: entry.size_bytes,
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
      throw new SharePointDecryptAuthError(`AES-GCM authentication failed for ${file_name}`, {
        cause: err,
      });
    }
    throw err;
  }
}

async function buffered_download_and_decrypt(
  ctx: TenantContext,
  entry: StoredBlobRef,
): Promise<Buffer | undefined> {
  let encrypted: Buffer;
  try {
    encrypted = await ctx.storage.get(entry.storage_key!);
  } catch (err) {
    logger.warn(
      `Missing or unreadable blob for ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  try {
    const content = ctx.decrypt(encrypted);
    const expected = entry.checksum;
    if (!expected || !plaintext_sha256_equals_expected(content, expected)) {
      logger.warn(
        expected
          ? `Checksum mismatch after decrypt for ${entry.file_name}; skipping restore`
          : `Missing checksum for ${entry.file_name}; skipping restore`,
      );
      return undefined;
    }
    return content;
  } catch (err) {
    if (is_gcm_auth_failure(err)) {
      throw new SharePointDecryptAuthError(`AES-GCM authentication failed for ${entry.file_name}`, {
        cause: err,
      });
    }
    logger.warn(
      `Failed to decrypt ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function plaintext_sha256_equals_expected(content: Buffer, expected_hex: string): boolean {
  const actual_hex = createHash('sha256').update(content).digest('hex');
  if (actual_hex.length !== expected_hex.length) return false;
  return timingSafeEqual(Buffer.from(actual_hex, 'utf8'), Buffer.from(expected_hex, 'utf8'));
}
