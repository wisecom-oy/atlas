import type { Writable } from 'node:stream';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';

export interface TeamsSaveOptions extends OperationControlOptions {
  readonly snapshot_id: string;
  /** Export only this channel. Omitted exports every channel in the snapshot. */
  readonly channel_id?: string | undefined;
  /** Output zip file path (default: auto-generated). Mutually exclusive with `output`. */
  readonly output_path?: string;
  /** A stream to write the archive to instead of a file. Mutually exclusive with `output_path`. */
  readonly output?: Writable;
}

export interface TeamsSaveResult {
  readonly snapshot_id: string;
  readonly channels_saved: number;
  readonly messages_saved: number;
  readonly images_inlined: number;
  /** Non-fatal problems: missing, unreadable, or checksum-mismatched blobs that were skipped. */
  readonly errors: string[];
  /** The path the archive landed on, or an empty string when it was written to a stream. */
  readonly output_path: string;
  readonly total_bytes: number;
  readonly interrupted: boolean;
}

export interface TeamsSaveUseCase {
  /** Exports a Teams snapshot to a zip archive of JSON transcripts and HTML pages, read from storage only. */
  save_snapshot(
    tenant_id: string,
    team_id: string,
    options: TeamsSaveOptions,
  ): Promise<TeamsSaveResult>;
}
