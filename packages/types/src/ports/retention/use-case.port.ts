import type { DeletionResult } from '@/ports/deletion/use-case.port';
import type { OperationControlOptions } from '@/ports/atlas/progress-event.port';

/** How far back an owner's history is kept, and whether anything is changed. */
export interface SnapshotPruneOptions extends Pick<
  OperationControlOptions,
  'should_interrupt' | 'abort_signal'
> {
  /**
   * The cut-off. Snapshots created strictly before it are removed; a snapshot created at exactly
   * this instant is kept, as `delete_snapshot` counts an equal time as newer. The newest snapshot
   * is always kept.
   */
  readonly before: Date;
  /** Reports what a run would remove and changes nothing. */
  readonly dry_run?: boolean | undefined;
}

/** Why the sweep of unreferenced content did not run, when it did not. */
export type ContentSweepSkipReason =
  /** A manifest or version index of the owner could not be read, so its references are unknown. */
  | 'unreadable_objects'
  /** The owner has quarantined manifests or version indexes, whose references are unknown. */
  | 'quarantined_objects'
  /** The run was cancelled before the sweep. */
  | 'interrupted';

/**
 * What a prune removed, or for a dry run what it would remove. The `DeletionResult` counts cover
 * every object version the run deleted: manifests count as manifests, and content, version
 * indexes and pointers as objects.
 */
export interface SnapshotPruneResult extends DeletionResult {
  readonly dry_run: boolean;
  /** The cut-off the run applied. */
  readonly before: Date;
  /**
   * The oldest kept snapshot, which now holds everything older snapshots contributed to it. Empty
   * when no snapshot was older than the cut-off. Several only when the oldest kept snapshots share
   * one creation time.
   */
  readonly baseline_snapshot_ids: string[];
  /** Snapshots older than the cut-off whose manifests were removed, or would be. */
  readonly removed_snapshot_ids: string[];
  /** Manifests older than the cut-off that Object Lock still retains; a later run removes them. */
  readonly retained_manifest_keys: string[];
  /** Manifests older than the cut-off whose deletion failed for another reason. */
  readonly failed_manifest_keys: string[];
  /** Bytes of the object versions deleted, or that a dry run would delete. */
  readonly deleted_bytes: number;
  /** Why unreferenced content was not swept; undefined when the sweep ran to the end. */
  readonly content_sweep_skipped?: ContentSweepSkipReason | undefined;
  /** True when the run was cancelled. A repeated run continues where this one stopped. */
  readonly interrupted: boolean;
}

/**
 * Removes one owner's snapshots older than a cut-off and keeps every newer one restorable
 * (issue #977). Outlook, OneDrive and SharePoint each bind one under their own token.
 */
export interface SnapshotPruneUseCase {
  /**
   * @throws OwnerBusyError when another operation holds the owner.
   * @throws UnreadableObjectsError when a manifest the prune must read is damaged.
   */
  prune_snapshots(
    tenant_id: string,
    owner_id: string,
    options: SnapshotPruneOptions,
  ): Promise<SnapshotPruneResult>;
}
