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
    require_condition_holds(request, await read_etag_for_condition(client, bucket, request));
    const written_etag = await send_put_object(client, bucket, without_conditions(request));
    await require_write_still_stored(client, bucket, request, written_etag);
  });
}

/** What a HEAD found under a key: nothing, or an object with the ETag the backend reported. */
type StoredEtag = { readonly present: false } | { readonly present: true; readonly etag?: string };

/** Refuses a create-only write onto a stored object, or a compare-and-swap on another ETag. */
function require_condition_holds(request: S3PutRequest, stored: StoredEtag): void {
  if (request.if_none_match === true && stored.present) {
    throw new PreconditionFailedError(request.key, 'an object already exists under the key');
  }
  if (!request.if_match) return;
  if (!stored.present) {
    throw new PreconditionFailedError(request.key, 'the object to replace no longer exists');
  }
  if (stored.etag === undefined) {
    throw new PreconditionFailedError(
      request.key,
      'the backend reported no ETag for the stored object, so the compare-and-swap cannot be checked',
    );
  }
  if (!same_etag(stored.etag, request.if_match)) {
    throw new PreconditionFailedError(request.key, 'the object changed since it was read');
  }
}

/**
 * Refuses when the key no longer holds this write. Compares ETags; when the PUT or the HEAD carries
 * none, the stored bytes are compared instead.
 */
async function require_write_still_stored(
  client: S3Client,
  bucket: string,
  request: S3PutRequest,
  written_etag: string | undefined,
): Promise<void> {
  if (!(await is_write_still_stored(client, bucket, request, written_etag))) {
    throw new PreconditionFailedError(request.key, LOST_RACE_DETAIL);
  }
}

/**
 * Whether the key still holds this write: by ETag when both the PUT and the HEAD reported one, and
 * byte for byte when either did not.
 */
async function is_write_still_stored(
  client: S3Client,
  bucket: string,
  request: S3PutRequest,
  written_etag: string | undefined,
): Promise<boolean> {
  if (written_etag === undefined) return stored_bytes_equal(client, bucket, request);
  const stored = await read_stored_etag(client, bucket, request.key);
  if (!stored.present) return false;
  if (stored.etag === undefined) return stored_bytes_equal(client, bucket, request);
  return same_etag(stored.etag, written_etag);
}

/**
 * What the condition is checked against. A compare-and-swap needs the stored ETag, so when HEAD
 * carries none it is read from a GET, which on such a backend is where the caller got it.
 */
async function read_etag_for_condition(
  client: S3Client,
  bucket: string,
  request: S3PutRequest,
): Promise<StoredEtag> {
  const stored = await read_stored_etag(client, bucket, request.key);
  if (!request.if_match || !stored.present || stored.etag !== undefined) return stored;
  return read_etag_by_get(client, bucket, request.key);
}

/** The ETag a GET of `key` reports, reading and discarding the body so the socket is released. */
async function read_etag_by_get(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<StoredEtag> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await response.Body?.transformToByteArray();
    return response.ETag ? { present: true, etag: response.ETag } : { present: true };
  } catch (err) {
    if (is_absent_object_error(err)) return { present: false };
    throw err;
  }
}

/** Whether an object is stored under `key`, and its ETag when the backend reports one. */
async function read_stored_etag(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<StoredEtag> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ETag ? { present: true, etag: head.ETag } : { present: true };
  } catch (err) {
    if (is_absent_object_error(err)) return { present: false };
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
function same_etag(left: string, right: string): boolean {
  return normalize_etag(left) === normalize_etag(right);
}

function normalize_etag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/^"|"$/g, '');
}
