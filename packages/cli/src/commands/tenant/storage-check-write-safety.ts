import type {
  StorageCheckResult,
  StorageConditionalWriteCheck,
  WriterExclusionMode,
} from '@wisecom/atlas-types';
import type { KeyValueItem } from '@/ui/components/key-value-list';

/**
 * Whether the conditional-write probe allows writes in the mode in effect. In the default mode a
 * backend that does not enforce the conditions cannot keep two runs off one owner, and every
 * command that writes refuses it (issues #623, #915). In an opt-in mode Atlas never sends them, so
 * the probe result is information only (issue #974).
 */
export function is_write_safety_ready(result: StorageCheckResult): boolean {
  if (writer_exclusion_of(result) !== 'storage_lease') return true;
  return result.conditional_writes.support !== 'ignored';
}

/**
 * Reports the conditional-write probe. `ignored` is the dangerous answer in the default mode: owner
 * leases, the data key bootstrap, create-only manifests and the identity registry all depend on the
 * backend enforcing these conditions, and every command that writes refuses such a bucket.
 */
export function describe_conditional_writes(
  check: StorageConditionalWriteCheck,
  mode: WriterExclusionMode,
): KeyValueItem {
  const label = 'Conditional writes';
  if (check.support === 'supported') return { label, value: 'supported', color: 'green' };
  const opt_in = mode !== 'storage_lease';
  if (check.support === 'ignored') {
    const value = `NOT ENFORCED: ${check.detail ?? 'see docs'}`;
    if (!opt_in) return { label, value, color: 'red' };
    return { label, value: `${value} (not sent in this mode)`, color: 'yellow' };
  }
  const reason = check.detail ?? 'no reason given';
  const suffix = opt_in ? ', not sent in this mode' : '';
  return { label, value: `not probed (${reason}${suffix})`, color: 'yellow' };
}

/** Reports what keeps two writers off one owner, and flags an opt-in the backend does not need. */
export function describe_writer_exclusion(result: StorageCheckResult): KeyValueItem {
  const label = 'Writer exclusion';
  const mode = writer_exclusion_of(result);
  if (mode === 'storage_lease') {
    return { label, value: 'owner leases in the bucket', color: 'green' };
  }
  const name =
    mode === 'single_writer'
      ? 'single writer (ATLAS_SINGLE_WRITER): one Atlas process per tenant'
      : 'host-supplied (ownerExclusion)';
  const unneeded =
    result.conditional_writes.support === 'supported'
      ? '; this backend enforces conditional writes, so the default owner lease would work here'
      : '';
  return { label, value: `${name}${unneeded}`, color: 'yellow' };
}

/** The mode a result names, read as the default lease when an older result carries none. */
export function writer_exclusion_of(result: StorageCheckResult): WriterExclusionMode {
  return result.writer_exclusion ?? 'storage_lease';
}
