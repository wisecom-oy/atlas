import type {
  HeldOwnerLease,
  ManifestObjectLockEffectivePolicy,
  ReadableSnapshotSummaries,
  SnapshotSummary,
  TenantContext,
} from '@wisecom/atlas-types';
import type { ReferencedKeySet } from '@/services/retention/referenced-key-set';

/**
 * Whether a prune step writes. A dry run reads and counts what it would delete; a run deletes,
 * under the owner's lease, which every step checks before it writes.
 */
export type PruneWrites =
  | {
      readonly dry_run: true;
      /**
       * Manifests whose recorded Object Lock retention still runs, which the dry run predicts
       * the backend will refuse to delete, as the run itself would find.
       */
      readonly retained_manifest_keys: ReadonlySet<string>;
    }
  | { readonly dry_run: false; readonly lease: HeldOwnerLease };

/**
 * A summary row with the Object Lock retention its manifest was written with, which every
 * Outlook, OneDrive and SharePoint row carries when the run requested retention (#975, #976).
 */
export interface RetainableSnapshotSummary extends SnapshotSummary {
  readonly object_lock?: ManifestObjectLockEffectivePolicy | undefined;
}

/** What the prune needs from a manifest of any workload whose snapshots form a chain. */
export interface PrunableManifest {
  readonly snapshot_id: string;
  readonly created_at: Date;
}

/** Folds one baseline's chain, fed newest first with the baseline itself first. */
export interface BaselineFold<M> {
  add(manifest: M): void;
  result(): M;
}

/** Why a reference scan could not account for every object it had to read. */
export type ReferenceScanOutcome = 'complete' | 'unreadable';

/**
 * Objects beside the manifests that outlive their snapshot unless removed, found by listing a
 * prefix: the drive run version indexes and manifest entry parts. A key is stale when its snapshot
 * was taken before the cut-off and no manifest of it remains. Finding them by listing, rather than
 * from the snapshots a run removes, is what lets a repeated run clean up after an interrupted one.
 */
export interface StaleSatellitePrefix {
  readonly prefix: string;
  /** The snapshot a key under the prefix belongs to; undefined leaves the key alone. */
  snapshot_of(key: string): string | undefined;
  /** When the snapshot was taken, from its id; undefined leaves the key alone. */
  taken_at(snapshot_id: string): number | undefined;
}

/**
 * One owner of one workload, as the prune sees it. Outlook and the two drive providers differ in
 * how a chain folds, which objects sit beside a manifest, and where content lives; the order of
 * the steps, and what makes them safe to interrupt, is shared (see `prune_owner_snapshots`).
 */
export interface SnapshotPruneTarget<M extends PrunableManifest> {
  /** Workload name for operator-facing messages, e.g. `OneDrive`. */
  readonly label: string;
  readonly ctx: TenantContext;
  /** The prefix holding exactly this owner's manifests. */
  readonly manifest_prefix: string;
  /** Prefixes holding content that only this owner's manifests and indexes reference. */
  readonly content_prefixes: readonly string[];
  /** Where quarantine moves this owner's manifests and indexes. */
  readonly quarantine_prefixes: readonly string[];
  /** Prefixes whose objects are removed once their snapshot's manifest is gone. */
  readonly stale_satellites: readonly StaleSatellitePrefix[];

  /** The owner's snapshots from its summary index, naming the damaged manifests. */
  list_summaries(): Promise<ReadableSnapshotSummaries<RetainableSnapshotSummary>>;
  /** Reads one manifest; undefined when absent, `UnreadableContentError` when damaged. */
  read_manifest(key: string): Promise<M | undefined>;
  /** A fresh fold for one baseline. */
  start_fold(): BaselineFold<M>;
  /** Whether the stored manifest already is the folded baseline, so no write is needed. */
  baseline_matches(stored: M, folded: M): boolean;
  /**
   * Makes the folded baseline the stored manifest of its snapshot, and anything the workload keeps
   * beside it consistent with it first. Checks the lease before each write.
   */
  commit_baseline(baseline: M, lease: HeldOwnerLease): Promise<void>;
  /**
   * Keys or prefixes removed before a pruned snapshot's manifest, such as the pointers that name
   * it. They go first so that a manifest is never left behind something that points at nothing.
   */
  satellite_scopes(snapshot_id: string): string[];
  /** Drops the removed snapshots' summary rows in one rewrite; logs instead of failing. */
  forget_rows(snapshot_ids: readonly string[], lease: HeldOwnerLease): Promise<void>;
  /** Records every storage key the manifest references. */
  add_references(manifest: M, references: ReferencedKeySet): void;
  /**
   * Records the keys referenced outside the manifests, such as drive version indexes, skipping
   * `excluded_keys`, which the prune removes. Reports whether every such object could be read.
   */
  add_external_references?(
    references: ReferencedKeySet,
    excluded_keys: ReadonlySet<string>,
  ): Promise<ReferenceScanOutcome>;
}
