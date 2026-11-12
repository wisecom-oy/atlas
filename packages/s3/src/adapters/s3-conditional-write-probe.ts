import { randomBytes } from 'node:crypto';
import type { ObjectStorage } from '@wisecom/atlas-types';
import { PreconditionFailedError } from '@/adapters/object-lock.errors';
import { logger } from '@wisecom/atlas-core';

/** Probe objects live here, next to the leases whose safety the probe measures. */
const PROBE_PREFIX = '_meta/storage-check/';

/**
 * Whether the bucket refuses a create-only write (`If-None-Match: *`) to a key that exists, which
 * is what makes two simultaneous run leases impossible. Writes one small probe object twice and
 * removes every version of it.
 *
 * Returns undefined when the probe cannot write at all (read-only credentials): unknown, not
 * unsupported.
 */
export async function probe_conditional_writes(
  storage: ObjectStorage,
): Promise<boolean | undefined> {
  const key = `${PROBE_PREFIX}conditional-write-${randomBytes(8).toString('hex')}.probe`;
  const body = Buffer.from('atlas conditional write probe');
  try {
    await storage.put(key, body, undefined, undefined, undefined, true);
  } catch (err) {
    logger.warn(`Conditional write probe could not write: ${describe(err)}`);
    return undefined;
  }
  try {
    await storage.put(key, body, undefined, undefined, undefined, true);
    return false;
  } catch (err) {
    if (err instanceof PreconditionFailedError) return true;
    logger.warn(`Conditional write probe got an unexpected answer: ${describe(err)}`);
    return undefined;
  } finally {
    await remove_probe(storage, key);
  }
}

/** Deletes every version of the probe, or the visible key when the bucket keeps no versions. */
async function remove_probe(storage: ObjectStorage, key: string): Promise<void> {
  try {
    const versions = await storage.list_versions(key);
    if (versions.length === 0) {
      await storage.delete(key);
      return;
    }
    for (const version of versions) await storage.delete_version(version.key, version.version_id);
  } catch (err) {
    logger.warn(`Could not remove the conditional write probe ${key}: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
