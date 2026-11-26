import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import type { KeyedWriteSerializer } from '@/adapters/keyed-write-serializer';
import { PreconditionFailedError } from '@/adapters/object-lock.errors';
import { send_put_object, type S3PutRequest } from '@/adapters/s3-object-put';

/** What the refusal of a condition Atlas checked itself says, by what it found. */
const LOST_RACE_DETAIL =
  'another writer replaced the object right after this write. With ATLAS_SINGLE_WRITER or an ' +
  'ownerExclusion, conditions are checked by Atlas rather than the backend, so a second process ' +
  'is writing this tenant';

/**
 * A create-only or compare-and-swap write for a backend that does not enforce, or rejects, the
 * conditions (issue #974). No condition header is sent:
 *
 * 1. Under the serializer, so no other write to the key in this process interleaves.
 * 2. HEAD the key and refuse, as the backend would with 412, when the condition does not hold.
 * 3. PUT unconditionally.
 * 4. HEAD again and refuse when the stored object is no longer the one just written, so a writer in
 *    another process that replaced it is reported instead of passed over.
 *
 * Step 4 narrows the race between processes; it cannot close it. A writer whose check ran before
 * step 3 and whose write lands after step 4 still replaces this object unseen. Keeping a second
 * process off the key is what the opt-in asks of the host or operator.
 *
 * @throws PreconditionFailedError when the condition fails, before writing, or after the write when
 *   another writer replaced the object.
 */
export async function put_with_checked_condition(
  client: S3Client,
  bucket: string,
  request: S3PutRequest,
  serializer: KeyedWriteSerializer,
): Promise<void> {
  await serializer.run(`${bucket}/${request.key}`, async () => {
    require_condition_holds(request, await read_current_etag(client, bucket, request.key));
    const written_etag = await send_put_object(client, bucket, without_conditions(request));
    await require_write_still_stored(client, bucket, request, written_etag);
  });
}

/** Refuses a create-only write onto a stored object, or a compare-and-swap on another ETag. */
function require_condition_holds(request: S3PutRequest, current_etag: string | undefined): void {
  if (request.if_none_match === true && current_etag !== undefined) {
    throw new PreconditionFailedError(request.key, 'an object already exists under the key');
  }
  if (!request.if_match) return;
  if (current_etag === undefined) {
    throw new PreconditionFailedError(request.key, 'the object to replace no longer exists');
  }
  if (!same_etag(current_etag, request.if_match)) {
    throw new PreconditionFailedError(request.key, 'the object changed since it was read');
  }
}

/**
 * Refuses when the key no longer holds this write. Compares ETags; a backend that returned none for
 * the PUT is checked byte for byte instead.
 */
async function require_write_still_stored(
  client: S3Client,
  bucket: string,
  request: S3PutRequest,
  written_etag: string | undefined,
): Promise<void> {
  const still_stored =
    written_etag === undefined
      ? await stored_bytes_equal(client, bucket, request)
      : same_etag(await read_current_etag(client, bucket, request.key), written_etag);
  if (!still_stored) throw new PreconditionFailedError(request.key, LOST_RACE_DETAIL);
}

/** The ETag of the object stored under `key`, or undefined when there is none. */
async function read_current_etag(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string | undefined> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ETag ?? '';
  } catch (err) {
    if (is_absent_object_error(err)) return undefined;
    throw err;
  }
}

async function stored_bytes_equal(
  client: S3Client,
  bucket: string,
  request: S3PutRequest,
): Promise<boolean> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: request.key }));
    const stored = await response.Body?.transformToByteArray();
    return stored !== undefined && Buffer.from(stored).equals(request.data);
  } catch (err) {
    if (is_absent_object_error(err)) return false;
    throw err;
  }
}

function without_conditions(request: S3PutRequest): S3PutRequest {
  return { ...request, if_match: undefined, if_none_match: undefined };
}

/** Compares ETags as the backend quotes them or not, and strong or weak. */
function same_etag(left: string | undefined, right: string): boolean {
  return left !== undefined && normalize_etag(left) === normalize_etag(right);
}

function normalize_etag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '');
}
