import { randomUUID } from 'node:crypto';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { is_precondition_failure } from '@wisecom/atlas-core/services/shared/precondition-failure';
import type { ObjectStorage, StorageConditionalWriteCheck } from '@wisecom/atlas-types';

/** Prefix of the throwaway objects the probe writes. Nothing else lives under it. */
const PROBE_PREFIX = '_meta/storage-check/';

/**
 * Checks that the backend refuses the two conditional writes Atlas relies on: a create-only write
 * (`If-None-Match: *`) onto an existing key, and a compare-and-swap (`If-Match`) with a stale ETag.
 * The owner lease, the data key bootstrap and the identity registry are only safe when both hold;
 * a backend that silently ignores the headers accepts every write (issue #623).
 *
 * Writes one small plaintext object under `_meta/storage-check/` and removes it again, including
 * its versions. A bucket that does not exist, or credentials that may not write, are reported as
 * not probed rather than as a failure: the check itself needs nothing but read access.
 */
export async function probe_conditional_writes(
  storage: ObjectStorage,
): Promise<StorageConditionalWriteCheck> {
  const key = `${PROBE_PREFIX}${randomUUID()}.probe`;
  try {
    await storage.put(key, Buffer.from('atlas storage-check probe 1'));
  } catch (err) {
    return { support: 'not_probed', detail: describe_unprobed_bucket(err) };
  }
  try {
    return await check_both_conditions(storage, key);
  } catch (err) {
    return { support: 'not_probed', detail: `the probe failed: ${error_text(err)}` };
  } finally {
    await remove_probe_object(storage, key);
  }
}

/** Sends both conditional writes against the probe object and names the ones that were accepted. */
async function check_both_conditions(
  storage: ObjectStorage,
  key: string,
): Promise<StorageConditionalWriteCheck> {
  const { etag: stale_etag } = await storage.get_with_etag(key);
  const create_only_refused = await is_write_refused(() =>
    storage.put(
      key,
      Buffer.from('atlas storage-check probe 2'),
      undefined,
      undefined,
      undefined,
      true,
    ),
  );
  // An unconditional overwrite, so the ETag read above no longer names the stored object.
  await storage.put(key, Buffer.from('atlas storage-check probe 3'));
  const stale_etag_refused = await is_write_refused(() =>
    storage.put(key, Buffer.from('atlas storage-check probe 4'), undefined, undefined, stale_etag),
  );
  if (create_only_refused && stale_etag_refused) return { support: 'supported' };
  const ignored = [
    ...(create_only_refused ? [] : ['If-None-Match: * (create-only)']),
    ...(stale_etag_refused ? [] : ['If-Match (compare-and-swap)']),
  ];
  return {
    support: 'ignored',
    detail: `the backend accepted a write with ${ignored.join(' and ')}`,
  };
}

/** True when the write was refused as a failed precondition; any other failure is rethrown. */
async function is_write_refused(write: () => Promise<void>): Promise<boolean> {
  try {
    await write();
    return false;
  } catch (err) {
    if (is_precondition_failure(err)) return true;
    throw err;
  }
}

/** Removes the probe object and every version of it; a leftover is harmless and is not reported. */
async function remove_probe_object(storage: ObjectStorage, key: string): Promise<void> {
  try {
    await storage.delete(key);
    for (const version of await storage.list_versions(key)) {
      if (version.key === key) await storage.delete_version(key, version.version_id);
    }
  } catch {
    // Retention or a missing delete permission keeps the object: a few bytes under the probe prefix.
  }
}

function describe_unprobed_bucket(err: unknown): string {
  return is_absent_object_error(err)
    ? 'the bucket does not exist yet'
    : `the probe object could not be written: ${error_text(err)}`;
}

function error_text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
