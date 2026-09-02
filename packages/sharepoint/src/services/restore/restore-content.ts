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
import type { StoredBlobRef, TenantContext } from '@wisecom/atlas-types';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { is_gcm_auth_failure } from '@wisecom/atlas-core/utils/gcm-auth';
import {
  should_stream_restore,
  stream_decrypt_from_storage,
  verify_streaming_checksum,
} from '@wisecom/atlas-drive/restore/streaming-restore';

/** Thrown when ciphertext decrypts with AES-GCM but fails the authentication tag check. */
export class SharePointDecryptAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SharePointDecryptAuthError';
  }
}

/** Returns the entry's verified plaintext, or undefined when it cannot be restored. */
export async function download_and_decrypt(
  ctx: TenantContext,
  entry: StoredBlobRef,
): Promise<Buffer | undefined> {
  if (!entry.storage_key) return undefined;

  return should_stream_restore(entry)
    ? stream_download_and_decrypt(ctx, entry)
    : buffered_download_and_decrypt(ctx, entry);
}

async function stream_download_and_decrypt(
  ctx: TenantContext,
  entry: StoredBlobRef,
): Promise<Buffer | undefined> {
  try {
    const { content, sha256_hex } = await stream_decrypt_from_storage(ctx, entry.storage_key!);
    if (!verify_streaming_checksum(entry, sha256_hex)) return undefined;
    return content;
  } catch (err) {
    if (is_gcm_auth_failure(err)) {
      throw new SharePointDecryptAuthError(`AES-GCM authentication failed for ${entry.file_name}`, {
        cause: err,
      });
    }
    logger.warn(
      `Streaming decrypt failed for ${entry.file_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
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
