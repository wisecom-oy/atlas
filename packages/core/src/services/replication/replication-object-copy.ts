import type {
  MultipartUploadHandle,
  ObjectStorage,
  ReplicationObjectResult,
  TenantContext,
} from '@wisecom/atlas-types';
import { ByteQueue } from '@/services/shared/byte-queue';
import { safe_abort_multipart, type CompletedPart } from '@/services/shared/stream-encrypt-upload';

/**
 * Bytes per multipart part when an object is streamed to a replica.
 *
 * Also the bound on memory per object in flight: at most one part plus one source chunk is held.
 * S3 allows 10,000 parts, so 16 MiB parts cover objects up to about 156 GiB, twice what the 8 MiB
 * backup upload path can write.
 */
export const REPLICATION_PART_BYTES = 16 * 1024 * 1024;

/** Counts from copying a list of keys, in the order the keys were given. */
export interface ObjectCopyTally {
  readonly object_results: ReplicationObjectResult[];
  readonly objects_copied: number;
  readonly objects_skipped: number;
  readonly objects_failed: number;
  readonly bytes_copied: number;
  readonly errors: string[];
}

interface CopiedObject {
  readonly result: ReplicationObjectResult;
  readonly bytes: number;
}

/** Copies every key the target does not already hold, tallying outcomes and bytes moved. */
export async function copy_objects_to_target(
  source_ctx: TenantContext,
  target_ctx: TenantContext,
  keys: readonly string[],
  part_bytes = REPLICATION_PART_BYTES,
): Promise<ObjectCopyTally> {
  const object_results: ReplicationObjectResult[] = [];
  let objects_copied = 0;
  let objects_skipped = 0;
  let objects_failed = 0;
  let bytes_copied = 0;
  const errors: string[] = [];

  for (const key of keys) {
    const { result, bytes } = await copy_object_if_absent(
      source_ctx.storage,
      target_ctx.storage,
      key,
      part_bytes,
    );
    object_results.push(result);
    if (result.outcome === 'copied') {
      objects_copied++;
      bytes_copied += bytes;
    } else if (result.outcome === 'skipped') {
      objects_skipped++;
    } else {
      objects_failed++;
      if (result.error) errors.push(`${key}: ${result.error}`);
    }
  }

  return { object_results, objects_copied, objects_skipped, objects_failed, bytes_copied, errors };
}

/** Streams one object to the target unless it is already there; a failure is reported, not thrown. */
async function copy_object_if_absent(
  source: ObjectStorage,
  target: ObjectStorage,
  key: string,
  part_bytes: number,
): Promise<CopiedObject> {
  try {
    if (await target.exists(key))
      return { result: { storage_key: key, outcome: 'skipped' }, bytes: 0 };
    const bytes = await stream_object_to_target(source, target, key, part_bytes);
    return { result: { storage_key: key, outcome: 'copied' }, bytes };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { result: { storage_key: key, outcome: 'failed', error }, bytes: 0 };
  }
}

/**
 * Copies one object with a single read of the source, returning the bytes written.
 *
 * The object used to be read whole into memory, written with one `PutObject` (capped at 5 GiB by
 * S3), then read a second time to count its bytes (issue #627). Now the source stream is cut into
 * `part_bytes` blocks: an object that fits in one block is written with a single `PutObject`, which
 * keeps its Content-MD5 check, and anything larger goes up as a multipart upload. The byte count is
 * what passed through, so no extra request is needed for it.
 */
export async function stream_object_to_target(
  source: ObjectStorage,
  target: ObjectStorage,
  key: string,
  part_bytes = REPLICATION_PART_BYTES,
): Promise<number> {
  const queue = new ByteQueue();
  const parts: CompletedPart[] = [];
  let handle: MultipartUploadHandle | undefined;
  let total_bytes = 0;

  try {
    for await (const chunk of await source.get_stream(key)) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      queue.push(bytes);
      total_bytes += bytes.length;
      // Strictly greater: a part is cut only once more bytes follow it, so the last part is never empty.
      while (queue.bytes > part_bytes) {
        handle ??= await target.begin_multipart_upload(key);
        parts.push(await upload_part(handle, parts.length + 1, queue.take(part_bytes)));
      }
    }

    if (!handle) {
      await target.put(key, queue.take(queue.bytes));
      return total_bytes;
    }
    parts.push(await upload_part(handle, parts.length + 1, queue.take(queue.bytes)));
    await handle.complete(parts);
    return total_bytes;
  } catch (err) {
    if (handle) await safe_abort_multipart(handle, key);
    throw err;
  }
}

async function upload_part(
  handle: MultipartUploadHandle,
  part_number: number,
  data: Buffer,
): Promise<CompletedPart> {
  return { ETag: await handle.upload_part(part_number, data), PartNumber: part_number };
}
