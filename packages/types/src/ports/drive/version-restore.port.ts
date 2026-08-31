import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';

/**
 * Where restored version bytes land.
 *
 * `copy` writes a sibling file and never touches the live one: the safe default
 * for a rollback whose correctness the operator has not confirmed yet.
 *
 * `in-place` uploads over the original path. The service keeps the previous
 * current version in its own version history, so the poisoned copy stays
 * recoverable, but the file users open changes immediately.
 */
export type DriveVersionPlacement = 'copy' | 'in-place';

export interface DriveVersionRestoreOptions extends OperationControlOptions {
  /** Graph item id or rooted path, e.g. `/Documents/Report.docx`. */
  readonly file_ref?: string | undefined;
  /** Exact stored version to restore. Requires `file_ref`. */
  readonly version_id?: string | undefined;
  /**
   * Bulk rollback: for every file in scope, restore the newest version Atlas
   * recorded at or before this instant. The point of the feature: a mass
   * encrypt-and-sync event has a known start time, not a known version id.
   */
  readonly before?: Date | undefined;
  /** Bulk rollback: limit to files under this rooted path prefix. */
  readonly path_prefix?: string | undefined;
  /** Defaults to `copy`. */
  readonly placement?: DriveVersionPlacement | undefined;
}

export interface DriveRestoredVersion {
  readonly file_id: string;
  /** Absent for a version row copied from a manifest entry rather than version sync. */
  readonly version_id: string | undefined;
  /** When the restored bytes were last modified in Microsoft 365. */
  readonly last_modified_at: string | undefined;
  readonly size_bytes: number;
  /** Path the bytes were written to, which differs from the original under `copy`. */
  readonly restored_to: string;
}

export interface DriveVersionRestoreResult {
  readonly files_restored: number;
  readonly files_skipped: number;
  readonly restored: DriveRestoredVersion[];
  readonly errors: string[];
  readonly interrupted: boolean;
  readonly placement: DriveVersionPlacement;
}
