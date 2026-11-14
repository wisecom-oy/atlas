import { createHash, timingSafeEqual } from 'node:crypto';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { stream_verified_plaintext } from '@wisecom/atlas-core/services/shared/stream-decrypt';
import { is_gcm_auth_failure } from '@wisecom/atlas-core/utils/gcm-auth';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  LargeFileContent,
  StoredBlobRef,
  StreamedFileContent,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import { should_stream_restore } from '@/restore/streaming-restore';

/**
 * Why one stored file cannot be restored. The text names the damage, never the storage key, which
 * carries the owner identifier into run summaries.
 */
export const DAMAGED_OBJECT_REASON =
  'stored object failed AES-GCM authentication: it was damaged or altered in storage';
const MISSING_OBJECT_REASON = 'stored object is missing';
const CHECKSUM_MISMATCH_REASON = 'decrypted content does not match its recorded SHA-256 checksum';
const MISSING_CHECKSUM_REASON = 'no checksum is recorded, so the content cannot be verified';

/** A stored file ready to upload, or the reason it cannot be restored. */
export type RestoreContentRead =
  | { readonly kind: 'readable'; readonly content: LargeFileContent }
  | { readonly kind: 'unrestorable'; readonly reason: string };

/**
 * Fetches one stored file for a OneDrive or SharePoint restore, verified against its manifest.
 *
 * A file past the streaming threshold comes back as a verified stream rather than a buffer, so
 * restoring it costs two upload chunks of memory instead of the whole plaintext (issue #343). The
 * shape is also the upload to use: only a file too large for the small-file upload streams.
 *
 * A failed AES-GCM tag here is damage to this one object, not a wrong key (issue #712). The data
 * key unwrapped and the snapshot's manifests decrypted under it before any file was read, so the
 * key is proven. The object is reported like any other unrestorable file and the run goes on.
 */
export async function read_restore_content(
  ctx: TenantContext,
  ref: StoredBlobRef,
): Promise<RestoreContentRead> {
  if (!ref.storage_key) return unrestorable(ref, MISSING_OBJECT_REASON);
  if (!ref.checksum) return unrestorable(ref, MISSING_CHECKSUM_REASON);
  if (should_stream_restore(ref)) {
    return { kind: 'readable', content: verified_stream(ctx, ref.storage_key, ref.checksum, ref) };
  }
  return read_buffered_content(ctx, ref.storage_key, ref.checksum, ref);
}

/**
 * Streaming path: the plaintext is never held whole, so the checksum is only comparable once the
 * last chunk has been produced.
 *
 * The upload it feeds must therefore not commit until the iteration ends, which the Graph upload
 * session guarantees by holding its final chunk back. A mismatch or a failed tag then abandons the
 * session and fails this one file, instead of leaving a wrong file in the drive.
 */
function verified_stream(
  ctx: TenantContext,
  storage_key: string,
  checksum: string,
  ref: StoredBlobRef,
): StreamedFileContent {
  return {
    chunks: authenticated_chunks(ctx, storage_key, checksum, ref.file_name),
    total_bytes: ref.size_bytes,
  };
}

/** Yields verified plaintext, naming an absent object or a failed tag as damage to this file. */
async function* authenticated_chunks(
  ctx: TenantContext,
  storage_key: string,
  checksum: string,
  file_name: string,
): AsyncGenerator<Buffer> {
  try {
    yield* stream_verified_plaintext(ctx, storage_key, checksum, file_name);
  } catch (err) {
    if (is_absent_object_error(err)) {
      throw new UnreadableContentError(MISSING_OBJECT_REASON, { cause: err });
    }
    if (is_gcm_auth_failure(err)) {
      throw new UnreadableContentError(DAMAGED_OBJECT_REASON, { cause: err });
    }
    throw err;
  }
}

/** Buffered path: reads, decrypts and checks a file at or below the streaming threshold. */
async function read_buffered_content(
  ctx: TenantContext,
  storage_key: string,
  checksum: string,
  ref: StoredBlobRef,
): Promise<RestoreContentRead> {
  let encrypted: Buffer;
  try {
    encrypted = await ctx.storage.get(storage_key);
  } catch (err) {
    return unrestorable(ref, storage_read_reason(err));
  }
  let content: Buffer;
  try {
    content = ctx.decrypt(encrypted, storage_key);
  } catch (err) {
    return unrestorable(ref, decrypt_failure_reason(err));
  }
  if (!sha256_equals(content, checksum)) return unrestorable(ref, CHECKSUM_MISMATCH_REASON);
  return { kind: 'readable', content };
}

/** Separates an absent object, which is damage, from a storage failure that says nothing of it. */
function storage_read_reason(err: unknown): string {
  if (is_absent_object_error(err)) return MISSING_OBJECT_REASON;
  return `stored object could not be read: ${error_message(err)}`;
}

/** Names a failed tag as damage and keeps any other decrypt failure's own message. */
function decrypt_failure_reason(err: unknown): string {
  if (is_gcm_auth_failure(err)) return DAMAGED_OBJECT_REASON;
  return `stored object could not be decrypted: ${error_message(err)}`;
}

/** Logs why a file is skipped and returns that reason as the read result. */
function unrestorable(ref: StoredBlobRef, reason: string): RestoreContentRead {
  logger.warn(`Cannot restore ${ref.file_name}: ${reason}`);
  return { kind: 'unrestorable', reason };
}

/** Compares a plaintext buffer with its expected SHA-256 checksum in constant time. */
function sha256_equals(content: Buffer, expected_hex: string): boolean {
  const actual_hex = createHash('sha256').update(content).digest('hex');
  if (actual_hex.length !== expected_hex.length) return false;
  return timingSafeEqual(Buffer.from(actual_hex, 'utf8'), Buffer.from(expected_hex, 'utf8'));
}

function error_message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
