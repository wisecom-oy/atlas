import type { Camelize } from '@/public/case-convert';
import type { SnapshotPruneResult } from '@/ports/retention/use-case.port';

/** Options of `pruneSnapshots` on the Outlook, OneDrive and SharePoint APIs. */
export interface SnapshotPruneSdkOptions {
  /**
   * The cut-off, as a `Date` or an ISO 8601 string. Snapshots created strictly before it are
   * removed; one created at exactly this instant is kept. The newest snapshot is always kept.
   */
  readonly before: Date | string;
  /** Report what would be removed and change nothing. */
  readonly dryRun?: boolean;
  /** Stops the run between steps; a repeated run continues where it stopped. */
  readonly signal?: AbortSignal;
}

/** What `pruneSnapshots` removed, or for a dry run would remove. */
export type SnapshotPruneSdkResult = Camelize<SnapshotPruneResult>;
