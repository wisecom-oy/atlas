import type { TenantContext } from '@wisecom/atlas-types';

/** Running totals and non-fatal problems for one export. */
export interface ExportTally {
  errors: string[];
  images_inlined: number;
  messages_saved: number;
  hosted_files: number;
  /** Hosted contents the backup never captured. Counted apart from errors, so the run exits 2. */
  hosted_missing: string[];
}

/** A tally with every count at zero. */
export function empty_export_tally(): ExportTally {
  return { errors: [], images_inlined: 0, messages_saved: 0, hosted_files: 0, hosted_missing: [] };
}

/** Writes one entry of the archive by its path. */
export type ArchiveEntrySink = (path: string, content: Buffer) => Promise<void>;

/** Where one channel's export writes: its archive folder, the entry sink, and the run's tally. */
export interface ThreadExportContext {
  readonly ctx: TenantContext;
  /** The archive folder that holds the channel, such as `channels/General-abc123`. */
  readonly directory: string;
  readonly write: ArchiveEntrySink;
  readonly tally: ExportTally;
}

/** A hosted content as messages.json lists it: its ID, Graph content type, and archive path. */
export interface SavedHostedFile {
  readonly id: string;
  readonly content_type?: string | undefined;
  readonly path: string;
}
