import { createHash } from 'node:crypto';
import type {
  MultipartUploadHandle,
  StorageObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';
import { logger } from '@/utils/logger';

/**
 * Multipart part size. Also the ceiling on retained memory: one part is held
 * back as `first_part_data` so the IV and auth tag can be prepended once the
 * cipher is finalised, and at most one more part accumulates in `pending`.
 */
const PART_SIZE = 8 * 1024 * 1024;

export interface CompletedPart {
  ETag: string;
  PartNumber: number;
}

export interface StreamEncryptUploadResult {
  readonly checksum: string;
  readonly handle: MultipartUploadHandle;
  readonly completed_parts: CompletedPart[];
}

export interface ContentAddressedStreamResult {
  readonly checksum: string;
  readonly storage_key: string;
  readonly stored: boolean;
  readonly deduplicated: boolean;
}

export interface ContentAddressedStreamTarget {
  /** Unique per-call staging key the encrypted stream lands on first. */
  readonly staging_key: string;
  /** Prefix used to sweep orphaned parts when an abort fails. */
  readonly staging_prefix: string;
  /** Builds the canonical key from the plaintext checksum. */
  build_data_key(checksum: string): string;
  readonly object_lock_policy?: StorageObjectLockPolicy;
}

/**
 * Streams an encrypted byte source into content-addressed storage.
 *
 * The canonical key is the plaintext SHA-256, which is only known once the
 * last byte has passed through, so the bytes land on a staging key first and
 * are promoted afterwards. An object that already exists is deduplicated by
 * aborting the staged upload rather than completing it.
 */
export async function stream_to_content_addressed_storage(
  ctx: TenantContext,
  chunks: AsyncIterable<Buffer>,
  target: ContentAddressedStreamTarget,
): Promise<ContentAddressedStreamResult> {
  const { checksum, handle, completed_parts } = await stream_encrypt_to_multipart(
    ctx,
    target.staging_key,
    chunks,
  );

  const canonical_key = target.build_data_key(checksum);

  if (await ctx.storage.exists(canonical_key)) {
    await safe_abort_multipart(handle, target.staging_prefix, ctx);
    return { checksum, storage_key: canonical_key, stored: false, deduplicated: true };
  }

  await handle.complete(completed_parts);

  // ponytail: the exists() check above races a concurrent writer, and the loser
  // overwrites with identical bytes -- canonical_key IS the SHA-256 of the
  // content, so the duplicate is benign. Conditional copy would make it atomic,
  // but MinIO ignores IfNoneMatch on CopyObject, so guarding it here would only
  // look safe. Revisit if a backend honours it.
  try {
    await ctx.storage.copy(target.staging_key, canonical_key, undefined, target.object_lock_policy);
  } catch (err) {
    logger.warn(`Copy staging->canonical failed, cleaning up: ${err}`);
    await ctx.storage.delete(target.staging_key).catch(() => {});
    throw err;
  }

  await ctx.storage.delete(target.staging_key).catch(() => {});

  return { checksum, storage_key: canonical_key, stored: true, deduplicated: false };
}

interface PendingPartState {
  pending: Buffer[];
  pending_bytes: number;
  first_part_data: Buffer | null;
  part_number: number;
  completed_parts: CompletedPart[];
}

/**
 * Encrypts an arbitrary byte stream straight into a multipart upload, never
 * holding the whole object.
 *
 * Peak retained memory is bounded by {@link PART_SIZE} regardless of object
 * size, which is the whole point: the plaintext arrives in chunks, each is
 * hashed and enciphered on the way past, and only assembled parts are kept.
 *
 * Part 1 is written last. AES-256-GCM only yields its auth tag after
 * `final()`, and the stored layout is `iv || auth_tag || ciphertext`, so the
 * first part cannot be uploaded until the last byte has been read. Every
 * intermediate part is exactly `PART_SIZE`, satisfying S3's 5 MB minimum for
 * non-final parts; only the highest-numbered part may be smaller.
 *
 * The caller owns the returned handle: nothing is completed or aborted here on
 * the success path, because the checksum is only known now and the caller may
 * still choose to abort as a deduplication hit.
 *
 * @param chunks Plaintext source. Any async iterable of buffers: a ranged
 *   chunk fetcher, or a Graph response stream.
 */
export async function stream_encrypt_to_multipart(
  ctx: TenantContext,
  staging_key: string,
  chunks: AsyncIterable<Buffer>,
): Promise<StreamEncryptUploadResult> {
  const { cipher, iv } = ctx.create_cipher();
  const hash = createHash('sha256');
  const handle = await ctx.storage.begin_multipart_upload(staging_key);

  try {
    const state: PendingPartState = {
      pending: [],
      pending_bytes: 0,
      first_part_data: null,
      part_number: 2,
      completed_parts: [],
    };

    for await (const chunk of chunks) {
      hash.update(chunk);
      const encrypted = cipher.update(chunk);
      if (encrypted.length === 0) continue;

      state.pending.push(encrypted);
      state.pending_bytes += encrypted.length;

      while (state.pending_bytes >= PART_SIZE) {
        await flush_pending_parts(handle, state);
      }
    }

    const final_block = cipher.final();
    if (final_block.length > 0) {
      state.pending.push(final_block);
      state.pending_bytes += final_block.length;
    }

    if (!state.first_part_data) {
      state.first_part_data = Buffer.concat(state.pending);
      state.pending.length = 0;
      state.pending_bytes = 0;
    }

    if (state.pending_bytes > 0) {
      const last_part = Buffer.concat(state.pending);
      const etag = await handle.upload_part(state.part_number, last_part);
      state.completed_parts.push({ ETag: etag, PartNumber: state.part_number });
    }

    const auth_tag = cipher.getAuthTag();
    const header_part = Buffer.concat([iv, auth_tag, state.first_part_data]);
    const part1_etag = await handle.upload_part(1, header_part);
    state.completed_parts.push({ ETag: part1_etag, PartNumber: 1 });

    state.completed_parts.sort((a, b) => a.PartNumber - b.PartNumber);

    return { checksum: hash.digest('hex'), handle, completed_parts: state.completed_parts };
  } catch (err) {
    await safe_abort_multipart(
      handle,
      staging_key.substring(0, staging_key.lastIndexOf('/') + 1),
      ctx,
    );
    throw err;
  }
}

/** Splits pending encrypted bytes into a full multipart upload part. */
async function flush_pending_parts(
  handle: MultipartUploadHandle,
  state: PendingPartState,
): Promise<void> {
  const combined = Buffer.concat(state.pending);
  state.pending.length = 0;
  state.pending_bytes = 0;

  const part_data = combined.subarray(0, PART_SIZE);
  if (combined.length > PART_SIZE) {
    const remainder = Buffer.from(combined.subarray(PART_SIZE));
    state.pending.push(remainder);
    state.pending_bytes = remainder.length;
  }

  if (!state.first_part_data) {
    state.first_part_data = Buffer.from(part_data);
  } else {
    const etag = await handle.upload_part(state.part_number, Buffer.from(part_data));
    state.completed_parts.push({ ETag: etag, PartNumber: state.part_number });
    state.part_number++;
  }
}

/** Aborts a multipart upload, falling back to sweeping orphaned parts by prefix. */
export async function safe_abort_multipart(
  handle: MultipartUploadHandle,
  staging_prefix: string,
  ctx: TenantContext,
): Promise<void> {
  try {
    await handle.abort();
  } catch (err) {
    logger.warn(`Multipart abort failed, cleaning up orphaned parts: ${err}`);
    await ctx.storage.abort_incomplete_uploads(staging_prefix).catch(() => {});
  }
}
