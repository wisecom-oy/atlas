import type { Writable } from 'node:stream';
import type { TransferProgressReporter } from '@/ports/shared/transfer-progress.port';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';

export interface SaveOptions extends OperationControlOptions {
  readonly folder_name?: string;
  readonly message_ref?: string;
  readonly start_date?: Date;
  readonly end_date?: Date;
  /** Where the archive lands on disk. Mutually exclusive with {@link SaveOptions.output}. */
  readonly output_path?: string;
  /**
   * A stream to write the archive to instead of a file, so an export can be piped straight to an
   * HTTP response or an upload without staging tens of gigabytes on local disk (issue #44).
   *
   * The stream receives bytes as they are produced and is ended when the archive finalizes. A run
   * that fails destroys it, so a consumer never receives a truncated archive as a success.
   */
  readonly output?: Writable;
  readonly skip_integrity_check?: boolean;
  /**
   * Also export items captured from Recoverable Items. Off by default, so an
   * ordinary export does not hand out deleted or hold-retained mail (issue #141).
   */
  readonly include_recoverable_items?: boolean;
  /** CLI presenter hook; when absent the service reports progress nowhere. */
  readonly create_progress?: (
    folders: { name: string; total_items: number }[],
  ) => TransferProgressReporter;
}

export interface SaveResult {
  readonly snapshot_id: string;
  readonly saved_count: number;
  readonly attachment_count: number;
  readonly error_count: number;
  readonly errors: string[];
  /** The path the archive landed on, or an empty string when it was written to a stream. */
  readonly output_path: string;
  readonly total_bytes: number;
  readonly interrupted: boolean;
  readonly integrity_failures: string[];
}

export interface SaveUseCase {
  /** Saves messages from a single snapshot to a zip archive of EML files. */
  save_snapshot(tenant_id: string, snapshot_id: string, options?: SaveOptions): Promise<SaveResult>;

  /** Saves messages from all snapshots for a mailbox, merged and deduplicated. */
  save_mailbox(tenant_id: string, owner_id: string, options?: SaveOptions): Promise<SaveResult>;
}
