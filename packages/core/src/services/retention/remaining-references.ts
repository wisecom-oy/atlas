import type { SnapshotSummary } from '@wisecom/atlas-types';
import { UnreadableContentError, UnreadableObjectsError } from '@wisecom/atlas-types';
import { ReferencedKeySet } from '@/services/retention/referenced-key-set';
import type {
  PrunableManifest,
  SnapshotPruneTarget,
} from '@/services/retention/snapshot-prune-target';

/**
 * Collects every key the owner's remaining manifests and indexes reference, one manifest in
 * memory at a time. Undefined when any of them cannot be read: a damaged manifest may reference
 * content nothing else does, so the sweep must not guess what it holds.
 */
export async function collect_remaining_references<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  remaining: AsyncIterable<M>,
  excluded_keys: ReadonlySet<string>,
): Promise<ReferencedKeySet | undefined> {
  const references = new ReferencedKeySet();
  try {
    for await (const manifest of remaining) target.add_references(manifest, references);
  } catch (err) {
    if (err instanceof UnreadableContentError) return undefined;
    throw err;
  }
  const external = await target.add_external_references?.(references, excluded_keys);
  return external === 'unreadable' ? undefined : references;
}

/**
 * Reads every manifest the owner has now, from a fresh summary listing. Raises
 * `UnreadableContentError` when one is damaged, including one without a summary row.
 */
export async function* stored_manifests<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
): AsyncGenerator<M> {
  const listing = await target.list_summaries();
  if (listing.unreadable_keys.length > 0) {
    throw new UnreadableObjectsError(
      `${target.label} manifests could not be read`,
      listing.unreadable_keys,
    );
  }
  yield* read_rows(target, listing.summaries);
}

/**
 * The manifests a dry run leaves in place: every kept snapshot read from storage, except the
 * baselines, which are taken as folded in memory.
 */
export async function* planned_manifests<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  kept: readonly SnapshotSummary[],
  baselines: readonly M[],
): AsyncGenerator<M> {
  const baseline_ids = new Set(baselines.map((baseline) => baseline.snapshot_id));
  yield* baselines;
  yield* read_rows(
    target,
    kept.filter((row) => !baseline_ids.has(row.snapshot_id)),
  );
}

/** Reads each row's manifest in turn; one gone since the listing references nothing. */
async function* read_rows<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  rows: readonly SnapshotSummary[],
): AsyncGenerator<M> {
  for (const row of rows) {
    const manifest = await target.read_manifest(row.manifest_key);
    if (manifest !== undefined) yield manifest;
  }
}
