import { createHash } from 'node:crypto';
import type {
  MultipartUploadHandle,
  StorageObjectLockPolicy,
  TenantContext,
} from '@wisecom/atlas-types';
import { ByteQueue } from '@/services/shared/byte-queue';
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
  /** Builds the canonical key from the plaintext checksum. */
  build_data_key(checksum: string): string;
  /**
   * The directory the finished object lives in, which the ciphertext is bound to.
   *
   * Not the staging key's: the object is promoted onto its content-addressed key and has to
   * decrypt from there, and the checksum that key is built from is unknown when the cipher is
   * created (issue #350).
   */
  readonly data_scope: string;
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
    target.data_scope,
  );

  const canonical_key = target.build_data_key(checksum);

  // Everything from here to `complete()` owns an upload that exists in the bucket. A throw in
  // between, an `exists()` that fails or a completion the backend refuses, used to leave it there
  // active and billable with nobody holding its id (issue #345).
  try {
    if (await ctx.storage.exists(canonical_key)) {
      await safe_abort_multipart(handle, target.staging_key);
      return { checksum, storage_key: canonical_key, stored: false, deduplicated: true };
    }

    await handle.complete(completed_parts);
  } catch (err) {
    await safe_abort_multipart(handle, target.staging_key);
    throw err;
  }

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
  pending: ByteQueue;
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
  scope_key: string = staging_key,
): Promise<StreamEncryptUploadResult> {
  const { cipher, iv, header } = ctx.create_cipher(scope_key);
  const hash = createHash('sha256');
  const handle = await ctx.storage.begin_multipart_upload(staging_key);

  try {
    const state: PendingPartState = {
      pending: new ByteQueue(),
      first_part_data: null,
      part_number: 2,
      completed_parts: [],
    };

    for await (const chunk of chunks) {
      hash.update(chunk);
      state.pending.push(cipher.update(chunk));

      while (state.pending.bytes >= PART_SIZE) {
        await flush_pending_parts(handle, state);
      }
    }

    state.pending.push(cipher.final());

    if (!state.first_part_data) {
      state.first_part_data = state.pending.take(state.pending.bytes);
    }

    if (state.pending.bytes > 0) {
      const last_part = state.pending.take(state.pending.bytes);
      const etag = await handle.upload_part(state.part_number, last_part);
      state.completed_parts.push({ ETag: etag, PartNumber: state.part_number });
    }

    const auth_tag = cipher.getAuthTag();
    const header_part = Buffer.concat([header, iv, auth_tag, state.first_part_data]);
    const part1_etag = await handle.upload_part(1, header_part);
    state.completed_parts.push({ ETag: part1_etag, PartNumber: 1 });

    state.completed_parts.sort((a, b) => a.PartNumber - b.PartNumber);

    return { checksum: hash.digest('hex'), handle, completed_parts: state.completed_parts };
  } catch (err) {
    await safe_abort_multipart(handle, staging_key);
    throw err;
  }
}

/** Splits pending encrypted bytes into a full multipart upload part. */
async function flush_pending_parts(
  handle: MultipartUploadHandle,
  state: PendingPartState,
): Promise<void> {
  const part_data = state.pending.take(PART_SIZE);

  if (!state.first_part_data) {
    state.first_part_data = part_data;
  } else {
    const etag = await handle.upload_part(state.part_number, part_data);
    state.completed_parts.push({ ETag: etag, PartNumber: state.part_number });
    state.part_number++;
  }
}

/**
 * Aborts one multipart upload and reports it when that fails.
 *
 * The fallback used to sweep every incomplete upload under the staging prefix, which is shared by
 * every large file of one owner: a failure in one run aborted the upload a concurrent run was
 * streaming into (issue #345). One failed abort leaves one upload's parts behind, which the
 * bucket's lifecycle rule and the age-filtered startup cleanup both collect, so the answer is to
 * name it rather than to widen the blast radius.
 */
export async function safe_abort_multipart(
  handle: MultipartUploadHandle,
  staging_key: string,
): Promise<void> {
  try {
    await handle.abort();
  } catch (err) {
    // A completion can fail on the client after the backend applied it, and the abort that follows
    // then finds no upload. Nothing is stranded in that case, so it is not an operator's problem.
    if (is_upload_already_gone(err)) {
      logger.debug(`Staging upload for ${staging_key} was already gone when the abort ran`);
      return;
    }
    logger.warn(
      `Could not abort the staging upload for ${staging_key}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Its parts stay billable until the bucket's lifecycle rule or the next run collects them.`,
    );
  }
}

/** Recognises the backend's answer for an upload id that no longer exists. */
function is_upload_already_gone(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('name' in err)) return false;
  return err.name === 'NoSuchUpload' || err.name === 'NotFound';
}
