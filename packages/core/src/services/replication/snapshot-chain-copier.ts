import type { ReplicationResult, TenantContext } from '@wisecom/atlas-types';
import {
  build_replication_result,
  type RawCopyResult,
} from '@/services/replication/replication-result-builder';

/** What chain ordering needs from a manifest of any workload whose snapshots are deltas. */
export interface ChainedManifest {
  readonly snapshot_id: string;
  readonly created_at: Date;
}

/**
 * How one workload copies a snapshot between two open contexts: where its manifest lives, which
 * owner's chain it belongs to, and how its objects and manifest are copied (manifest last).
 */
export interface SnapshotChainCopyPlan<TManifest extends ChainedManifest> {
  readonly manifest_key: (manifest: TManifest) => string;
  /** The mailbox, drive owner or site whose chain the manifest is a link of. */
  readonly owner_of: (manifest: TManifest) => string;
  readonly copy: (
    source_ctx: TenantContext,
    dest_ctx: TenantContext,
    manifest: TManifest,
    manifest_key: string,
  ) => Promise<RawCopyResult>;
}

/** One snapshot the copier attempted, and how it went. */
export interface CopiedChainLink<TManifest> {
  readonly manifest: TManifest;
  readonly result: ReplicationResult;
}

/** Called once per attempted snapshot as soon as its copy ends, before the next one starts. */
export type ChainLinkObserver<TManifest> = (link: CopiedChainLink<TManifest>) => Promise<void>;

/** What to copy, and how. */
export interface ChainCopyRequest<TManifest extends ChainedManifest> {
  /** The snapshots to bring to the destination, in any order. */
  readonly manifests: readonly TManifest[];
  readonly plan: SnapshotChainCopyPlan<TManifest>;
  /** Target id reported in each result. */
  readonly dest_id: string;
  /**
   * The snapshot a `-s` run was asked for. Its chain includes manifests with the same `created_at`,
   * so among equal times it is copied last, after every link it folds.
   */
  readonly target_snapshot_id?: string;
  /** Sees each attempted snapshot as soon as it is copied, before the next one starts. */
  readonly on_attempted?: ChainLinkObserver<TManifest>;
}

/** Everything a chain copy did, in the order it went. */
export interface SnapshotChainCopyOutcome<TManifest> {
  /** Snapshots whose copy was attempted, oldest first, including any that failed. */
  readonly attempted: CopiedChainLink<TManifest>[];
  /** Snapshots the destination already held, which were not touched. */
  readonly present: TManifest[];
  /** Snapshots left out because an older snapshot of the same owner failed to copy. */
  readonly not_copied: TManifest[];
}

/**
 * Copies every snapshot the destination lacks, oldest first, stopping an owner's chain at its
 * first failure.
 *
 * A manifest names only its own run's changes, and a snapshot is its manifest folded with every
 * older one of the owner. A newer manifest written after an older one failed would read as a
 * whole snapshot on the destination while missing everything the failed one recorded (issue #714).
 * So once a snapshot of an owner fails, no newer snapshot of that owner is written, and the failed
 * snapshot's result names the ones left out. The destination always holds a complete prefix of each
 * chain, and a rerun resumes at the gap, because snapshots already present are skipped.
 *
 * `on_attempted` sees each attempted snapshot as soon as it is copied, so a record of it survives a
 * run that dies later in the chain.
 */
export async function copy_missing_chain_links<TManifest extends ChainedManifest>(
  source_ctx: TenantContext,
  dest_ctx: TenantContext,
  request: ChainCopyRequest<TManifest>,
): Promise<SnapshotChainCopyOutcome<TManifest>> {
  const { plan, dest_id } = request;
  const attempted: CopiedChainLink<TManifest>[] = [];
  const present: TManifest[] = [];
  const not_copied: TManifest[] = [];
  const failed_by_owner = new Map<string, CopiedChainLink<TManifest>>();

  for (const manifest of copy_order(request.manifests, request.target_snapshot_id)) {
    if (failed_by_owner.has(plan.owner_of(manifest))) {
      not_copied.push(manifest);
      continue;
    }
    const key = plan.manifest_key(manifest);
    if (await dest_ctx.storage.exists(key)) {
      present.push(manifest);
      continue;
    }
    const link = await copy_chain_link(source_ctx, dest_ctx, manifest, key, plan, dest_id);
    attempted.push(link);
    await request.on_attempted?.(link);
    if (link.result.objects_failed > 0) failed_by_owner.set(plan.owner_of(manifest), link);
  }

  return {
    attempted: attempted.map((link) => with_left_out_snapshots(link, not_copied, plan)),
    present,
    not_copied,
  };
}

/** Every result the copy produced, in order: what a caller reports or merges. */
export function attempted_results<TManifest>(
  outcome: SnapshotChainCopyOutcome<TManifest>,
): ReplicationResult[] {
  return outcome.attempted.map((link) => link.result);
}

/**
 * Orders manifests oldest first. Among equal `created_at` the requested snapshot goes last, since
 * the chain loaders fold a same-time manifest into its chain, and the rest go by snapshot id. The
 * order then never depends on how a listing happened to return them.
 */
export function copy_order<TManifest extends ChainedManifest>(
  manifests: readonly TManifest[],
  target_snapshot_id?: string,
): TManifest[] {
  const is_target = (m: TManifest): number => (m.snapshot_id === target_snapshot_id ? 1 : 0);
  return [...manifests].sort(
    (a, b) =>
      a.created_at.getTime() - b.created_at.getTime() ||
      is_target(a) - is_target(b) ||
      a.snapshot_id.localeCompare(b.snapshot_id),
  );
}

async function copy_chain_link<TManifest extends ChainedManifest>(
  source_ctx: TenantContext,
  dest_ctx: TenantContext,
  manifest: TManifest,
  manifest_key: string,
  plan: SnapshotChainCopyPlan<TManifest>,
  dest_id: string,
): Promise<CopiedChainLink<TManifest>> {
  const start = Date.now();
  const raw = await plan.copy(source_ctx, dest_ctx, manifest, manifest_key);
  const result = build_replication_result(raw, manifest.snapshot_id, dest_id, Date.now() - start);
  return { manifest, result };
}

/**
 * Adds to a failed link's errors the newer snapshots of its owner that were left out because of
 * it. A link that did not fail, or left nothing out, is returned unchanged.
 */
function with_left_out_snapshots<TManifest extends ChainedManifest>(
  link: CopiedChainLink<TManifest>,
  not_copied: readonly TManifest[],
  plan: SnapshotChainCopyPlan<TManifest>,
): CopiedChainLink<TManifest> {
  if (link.result.objects_failed === 0) return link;
  const owner = plan.owner_of(link.manifest);
  const left_out = not_copied
    .filter((manifest) => plan.owner_of(manifest) === owner)
    .map((manifest) => manifest.snapshot_id);
  if (left_out.length === 0) return link;
  const message =
    `Stopped at snapshot ${link.manifest.snapshot_id}: newer snapshots build on it and were ` +
    `not copied: ${left_out.join(', ')}. Rerun to resume.`;
  return { ...link, result: { ...link.result, errors: [...link.result.errors, message] } };
}
