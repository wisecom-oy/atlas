import type { ReplicationResult, ReplicationStatusRecord } from '@wisecom/atlas-types';
import { ReplicationStatus, ReplicationVerificationStatus } from '@wisecom/atlas-types';
import type { StorageTarget } from '@wisecom/atlas-types';
import type { Manifest } from '@wisecom/atlas-types';

/** Raw counts returned by the snapshot replicator. */
export interface RawCopyResult {
  readonly objects_copied: number;
  readonly objects_skipped: number;
  readonly objects_failed: number;
  readonly bytes_copied: number;
  readonly errors: string[];
  readonly source_manifest_checksum?: string;
  readonly replicated_manifest_checksum?: string;
}

export function build_replication_result(
  raw: RawCopyResult,
  snapshot_id: string,
  target_id: string,
  elapsed_ms: number,
): ReplicationResult {
  const status =
    raw.objects_failed > 0
      ? raw.objects_copied > 0
        ? ReplicationStatus.PARTIAL
        : ReplicationStatus.FAILED
      : ReplicationStatus.COMPLETED;

  return {
    snapshot_id,
    target_id,
    status,
    objects_total: raw.objects_copied + raw.objects_skipped + raw.objects_failed,
    objects_copied: raw.objects_copied,
    objects_skipped: raw.objects_skipped,
    objects_failed: raw.objects_failed,
    bytes_copied: raw.bytes_copied,
    elapsed_ms,
    errors: raw.errors,
    verification_status: ReplicationVerificationStatus.SKIPPED,
    ...(raw.source_manifest_checksum !== undefined
      ? { source_manifest_checksum: raw.source_manifest_checksum }
      : {}),
    ...(raw.replicated_manifest_checksum !== undefined
      ? { replicated_manifest_checksum: raw.replicated_manifest_checksum }
      : {}),
  };
}

export function build_skip_result(snapshot_id: string, target_id: string): ReplicationResult {
  return {
    snapshot_id,
    target_id,
    status: ReplicationStatus.COMPLETED,
    objects_total: 0,
    objects_copied: 0,
    objects_skipped: 0,
    objects_failed: 0,
    bytes_copied: 0,
    elapsed_ms: 0,
    errors: [],
    verification_status: ReplicationVerificationStatus.SKIPPED,
  };
}

/** Aggregates several replication results into one, summing counts and concatenating errors. */
export function merge_replication_results(
  results: readonly ReplicationResult[],
  snapshot_id: string,
  target_id: string,
): ReplicationResult {
  let objects_copied = 0;
  let objects_skipped = 0;
  let objects_failed = 0;
  let bytes_copied = 0;
  let elapsed_ms = 0;
  const errors: string[] = [];

  for (const r of results) {
    objects_copied += r.objects_copied;
    objects_skipped += r.objects_skipped;
    objects_failed += r.objects_failed;
    bytes_copied += r.bytes_copied;
    elapsed_ms += r.elapsed_ms;
    errors.push(...r.errors);
  }

  return build_replication_result(
    { objects_copied, objects_skipped, objects_failed, bytes_copied, errors },
    snapshot_id,
    target_id,
    elapsed_ms,
  );
}

export function to_status_record(
  result: ReplicationResult,
  target: StorageTarget,
  manifest: Manifest,
): ReplicationStatusRecord {
  const last_err = result.errors.length > 0 ? result.errors[result.errors.length - 1] : undefined;
  return {
    target_id: target.target_id,
    target_endpoint: target.endpoint,
    snapshot_id: manifest.snapshot_id,
    owner_id: manifest.owner_id,
    status: result.status,
    started_at: new Date(Date.now() - result.elapsed_ms).toISOString(),
    completed_at: new Date().toISOString(),
    objects_total: result.objects_total,
    objects_copied: result.objects_copied,
    objects_skipped: result.objects_skipped,
    objects_failed: result.objects_failed,
    bytes_total: manifest.total_size_bytes,
    bytes_copied: result.bytes_copied,
    ...(last_err !== undefined ? { last_error: last_err } : {}),
    verification_status: result.verification_status,
    source_manifest_checksum: result.source_manifest_checksum ?? '',
    replicated_manifest_checksum: result.replicated_manifest_checksum ?? '',
  };
}
