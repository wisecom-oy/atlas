import { randomUUID } from 'node:crypto';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';
import { is_precondition_failure } from '@wisecom/atlas-core/services/shared/precondition-failure';
import type {
  ConditionalWriteViolation,
  ObjectStorage,
  StorageConditionalWriteCheck,
} from '@wisecom/atlas-types';
import { is_access_denied } from '@/adapters/s3-error-classifier';

/** Prefix of the throwaway objects the probe writes. Nothing else lives under it. */
const PROBE_PREFIX = '_meta/storage-check/';

/** The storage calls the probe makes. Its writes must reach the backend without any guard. */
export type ConditionalWriteProbeTarget = Pick<
  ObjectStorage,
  'put' | 'get_with_etag' | 'delete' | 'list_versions' | 'delete_version'
>;

/** A probe answer, and whether a later probe in the same process could answer differently. */
export interface ConditionalWriteProbeOutcome {
  readonly check: StorageConditionalWriteCheck;
  /**
   * True when the probe could not run for a reason that may pass: the bucket does not exist yet,
   * or a request failed. False for a verdict, and for credentials that may not write.
   */
  readonly provisional: boolean;
}

/** How each broken rule reads in `detail`. */
const VIOLATION_TEXT: Record<ConditionalWriteViolation, string> = {
  create_only: 'accepted a create-only write (If-None-Match: *) onto an existing object',
  stale_if_match: 'accepted a compare-and-swap (If-Match) with a stale ETag',
  current_if_match: 'refused a compare-and-swap (If-Match) with the current ETag',
};

/**
 * Checks the three conditional-write rules Atlas relies on: a create-only write (`If-None-Match:
 * *`) onto an existing key is refused, a compare-and-swap (`If-Match`) with a stale ETag is
 * refused, and one with the current ETag is accepted. The owner lease, the data key bootstrap,
 * create-only manifests and the identity registry are only safe when all three hold (issues #623,
 * #915).
 *
 * Writes one small plaintext object under `_meta/storage-check/` and removes it again, including
 * its versions. A bucket that does not exist, or credentials that may not write, are reported as
 * not probed rather than as a failure.
 */
export async function probe_conditional_writes(
  storage: ConditionalWriteProbeTarget,
): Promise<StorageConditionalWriteCheck> {
  return (await run_conditional_write_probe(storage)).check;
}

/** Runs the probe and says whether its answer may change within this process. */
export async function run_conditional_write_probe(
  storage: ConditionalWriteProbeTarget,
): Promise<ConditionalWriteProbeOutcome> {
  const key = `${PROBE_PREFIX}${randomUUID()}.probe`;
  try {
    await storage.put(key, probe_body(1));
  } catch (err) {
    return {
      check: { support: 'not_probed', detail: describe_unprobed_bucket(err) },
      provisional: !is_access_denied(err),
    };
  }
  try {
    return { check: describe_violations(await find_violations(storage, key)), provisional: false };
  } catch (err) {
    return {
      check: { support: 'not_probed', detail: `the probe failed: ${error_text(err)}` },
      provisional: true,
    };
  } finally {
    await remove_probe_object(storage, key);
  }
}

/** Sends the three conditional writes against the probe object and lists the rules broken. */
async function find_violations(
  storage: ConditionalWriteProbeTarget,
  key: string,
): Promise<ConditionalWriteViolation[]> {
  const { etag: stale_etag } = await storage.get_with_etag(key);
  const create_only_refused = await is_write_refused(() =>
    storage.put(key, probe_body(2), undefined, undefined, undefined, true),
  );
  // An unconditional overwrite, so the ETag read above no longer names the stored object.
  await storage.put(key, probe_body(3));
  const stale_etag_refused = await is_write_refused(() =>
    storage.put(key, probe_body(4), undefined, undefined, stale_etag),
  );
  const { etag: current_etag } = await storage.get_with_etag(key);
  const current_etag_refused = await is_write_refused(() =>
    storage.put(key, probe_body(5), undefined, undefined, current_etag),
  );
  return [
    ...(create_only_refused ? [] : (['create_only'] as const)),
    ...(stale_etag_refused ? [] : (['stale_if_match'] as const)),
    ...(current_etag_refused ? (['current_if_match'] as const) : []),
  ];
}

/** Turns the broken rules into the check result. No broken rule means the backend is supported. */
function describe_violations(
  violations: readonly ConditionalWriteViolation[],
): StorageConditionalWriteCheck {
  if (violations.length === 0) return { support: 'supported' };
  const broken = violations.map((violation) => VIOLATION_TEXT[violation]);
  return { support: 'ignored', detail: `the backend ${broken.join('; ')}`, violations };
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
async function remove_probe_object(
  storage: ConditionalWriteProbeTarget,
  key: string,
): Promise<void> {
  try {
    await storage.delete(key);
    for (const version of await storage.list_versions(key)) {
      if (version.key === key) await storage.delete_version(key, version.version_id);
    }
  } catch {
    // Retention or a missing delete permission keeps the object: a few bytes under the probe prefix.
  }
}

function probe_body(step: number): Buffer {
  return Buffer.from(`atlas storage-check probe ${step}`);
}

function describe_unprobed_bucket(err: unknown): string {
  return is_absent_object_error(err)
    ? 'the bucket does not exist yet'
    : `the probe object could not be written: ${error_text(err)}`;
}

function error_text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
