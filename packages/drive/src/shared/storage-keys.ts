import { randomBytes } from 'node:crypto';
import { normalize_owner_id } from '@wisecom/atlas-core/services/shared/identifier-normalization';

/**
 * Extra explanation appended to an invalid-segment error. SharePoint uses it to name the real
 * cause: a URL in a key segment means a caller skipped site resolution (issue #90), and blaming
 * the key alone sends the operator to the wrong layer.
 */
export type InvalidSegmentHint = (value: string) => string;

/** Every key and prefix a drive workload writes, all under one `<workload>/` namespace. */
export interface DriveStorageKeys {
  /** Prefix for content-addressed file blobs. */
  readonly data_prefix: string;
  /** Prefix for multipart staging objects before the deduplication copy. */
  readonly staging_prefix: string;
  /** Prefix for snapshot manifest JSON objects. */
  readonly manifest_prefix: string;
  /** Prefix for version index objects (one per backup run, plus legacy per-file objects). */
  readonly index_prefix: string;
  /** Prefix for sync metadata, such as delta cursors. */
  readonly meta_prefix: string;
  /** Ensures a single path segment is safe for S3-style keys (no traversal or extra slashes). */
  validate_key_segment(value: string): void;
  /** Builds the content-addressed key for a stored file blob. */
  data_key(owner_id: string, checksum: string): string;
  /** Builds the key for a snapshot manifest. */
  manifest_key(owner_id: string, snapshot_id: string): string;
  /** Builds the prefix for listing all manifests of one owning segment. */
  manifest_prefix_for(owner_id: string): string;
  /** Returns the root prefix for all manifests of the workload. */
  manifest_root_prefix(): string;
  /** Builds the key for one backup run's version index object (issue #161). */
  run_index_key(owner_id: string, snapshot_id: string): string;
  /**
   * Prefix listing every version index object of one owning segment. Covers both the per-run
   * objects and the legacy per-file objects written before issue #161, so reads keep seeing
   * history recorded by older Atlas versions.
   */
  index_prefix_for(owner_id: string): string;
  /** Returns the root prefix for all version index objects of the workload. */
  index_root_prefix(): string;
  /** Builds a unique staging key for the multipart upload of a file. */
  staging_key(owner_id: string, item_id: string): string;
  /** Builds the prefix for listing staging objects. */
  staging_prefix_for(owner_id: string): string;
  /** Builds the key for the delta cursor state. */
  delta_cursor_key(owner_id: string): string;
}

/**
 * Builds the key layout for one drive workload. The two providers differ only in the namespace
 * and in how an invalid segment is explained, so the layout itself lives here once: a key written
 * by one provider and read back by the other would be a silent data-loss bug, and a single builder
 * is what keeps the two from drifting apart.
 */
export function build_drive_storage_keys(
  workload: string,
  invalid_segment_hint?: InvalidSegmentHint,
): DriveStorageKeys {
  const data_prefix = `${workload}/data`;
  const staging_prefix = `${workload}/staging`;
  const manifest_prefix = `${workload}/manifests`;
  const index_prefix = `${workload}/index`;
  const meta_prefix = `${workload}/_meta`;

  function validate_key_segment(value: string): void {
    if (value === '' || value === '.' || value === '..') {
      throw new Error(`Invalid storage key segment: ${JSON.stringify(value)}`);
    }
    for (let i = 0; i < value.length; i++) {
      const ch = value.charCodeAt(i);
      if (ch === 47 || ch === 92 || ch === 0) {
        const hint = invalid_segment_hint?.(value) ?? '';
        throw new Error(`Invalid storage key segment: ${JSON.stringify(value)}${hint}`);
      }
    }
  }

  /**
   * Validates the owning segment and returns it in the one case every path agrees on. Services
   * normalize on entry; this is the backstop that keeps a path which forgets from writing a
   * second prefix for the same owner (issue #38).
   */
  function owning_segment(owner_id: string): string {
    validate_key_segment(owner_id);
    return normalize_owner_id(owner_id);
  }

  return {
    data_prefix,
    staging_prefix,
    manifest_prefix,
    index_prefix,
    meta_prefix,
    validate_key_segment,
    data_key(owner_id, checksum) {
      const owner = owning_segment(owner_id);
      validate_key_segment(checksum);
      return `${data_prefix}/${owner}/${checksum}`;
    },
    manifest_key(owner_id, snapshot_id) {
      const owner = owning_segment(owner_id);
      validate_key_segment(snapshot_id);
      return `${manifest_prefix}/${owner}/${snapshot_id}.json`;
    },
    manifest_prefix_for(owner_id) {
      return `${manifest_prefix}/${owning_segment(owner_id)}/`;
    },
    manifest_root_prefix() {
      return `${manifest_prefix}/`;
    },
    run_index_key(owner_id, snapshot_id) {
      const owner = owning_segment(owner_id);
      validate_key_segment(snapshot_id);
      return `${index_prefix}/${owner}/runs/${snapshot_id}.json`;
    },
    index_prefix_for(owner_id) {
      return `${index_prefix}/${owning_segment(owner_id)}/`;
    },
    index_root_prefix() {
      return `${index_prefix}/`;
    },
    staging_key(owner_id, item_id) {
      const owner = owning_segment(owner_id);
      validate_key_segment(item_id);
      const suffix = randomBytes(4).toString('hex');
      return `${staging_prefix}/${owner}/${item_id}-${suffix}`;
    },
    staging_prefix_for(owner_id) {
      return `${staging_prefix}/${owning_segment(owner_id)}/`;
    },
    delta_cursor_key(owner_id) {
      return `${meta_prefix}/${owning_segment(owner_id)}/delta.json`;
    },
  };
}
