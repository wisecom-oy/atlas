import type { Writable } from 'node:stream';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';

export interface FileSaveOptions extends OperationControlOptions {
  readonly snapshot_id: string;
  /** Only save specific files (by file ID or full path). */
  readonly file_filter?: string[];
  /** Output zip file path (default: auto-generated). Mutually exclusive with `output`. */
  readonly output_path?: string;
  /**
   * A stream to write the archive to instead of a file, for exports that must not touch local
   * disk (issue #44). Ended when the archive finalizes, destroyed when the run fails.
   */
  readonly output?: Writable;
  /** Skip SHA-256 integrity checks. */
  readonly skip_integrity_check?: boolean;
}

export interface FileSaveResult {
  readonly snapshot_id: string;
  readonly files_saved: number;
  readonly files_skipped: number;
  readonly errors: string[];
  readonly integrity_failures: string[];
  /** The path the archive landed on, or an empty string when it was written to a stream. */
  readonly output_path: string;
  readonly total_bytes: number;
  readonly interrupted: boolean;
}

export interface OneDriveSaveUseCase {
  /** Saves files from a OneDrive snapshot to a local zip archive. */
  save_snapshot(
    tenant_id: string,
    owner_id: string,
    options: FileSaveOptions,
  ): Promise<FileSaveResult>;
}

export interface SharePointSaveUseCase {
  /** Saves files from a SharePoint snapshot to a local zip archive. */
  save_snapshot(
    tenant_id: string,
    site_id: string,
    options: FileSaveOptions,
  ): Promise<FileSaveResult>;
}
