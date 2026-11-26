import type { ContentSweepSkipReason, SnapshotPruneOptions } from '@wisecom/atlas-types';
import { is_prune_interrupted } from '@/services/retention/prune-interruption';
import {
  settle_versions,
  versions_under,
  type PruneTally,
  type PrunableVersion,
} from '@/services/retention/prune-tally';
import { assert_lease_held } from '@/services/retention/pruned-manifest-removal';
import type { ReferencedKeySet } from '@/services/retention/referenced-key-set';
import { collect_remaining_references } from '@/services/retention/remaining-references';
import type {
  PrunableManifest,
  PruneWrites,
  SnapshotPruneTarget,
} from '@/services/retention/snapshot-prune-target';

/** The manifests the sweep keeps content for, and the satellite keys it no longer counts. */
export interface SweepReferences<M> {
  readonly remaining: AsyncIterable<M>;
  readonly excluded_keys: ReadonlySet<string>;
}

/**
 * Deletes every version of every content object under the owner's content prefixes that no
 * remaining manifest or index references, or for a dry run counts them. Returns why the sweep did
 * not run to the end, or undefined when it did.
 *
 * Content keys are per owner: a blob's ciphertext is bound to its owner's prefix, so another
 * owner's manifest can never reference it, and deduplication never crosses owners. The scan
 * therefore reads this owner's manifests and indexes only. It is skipped while the owner has a
 * quarantined manifest or index, or one that cannot be read, because their references are unknown.
 */
export async function sweep_unreferenced_content<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
  sources: SweepReferences<M>,
  writes: PruneWrites,
  tally: PruneTally,
  options: SnapshotPruneOptions,
): Promise<ContentSweepSkipReason | undefined> {
  if (await has_quarantined_objects(target)) return 'quarantined_objects';
  const references = await collect_remaining_references(
    target,
    sources.remaining,
    sources.excluded_keys,
  );
  if (references === undefined) return 'unreadable_objects';

  const storage = target.ctx.storage;
  for (const prefix of target.content_prefixes) {
    if (is_prune_interrupted(options)) return 'interrupted';
    assert_lease_held(writes);
    const versions = unreferenced(versions_under(storage, prefix), references, options);
    await settle_versions(storage, versions, tally, { dry_run: writes.dry_run });
  }
  return is_prune_interrupted(options) ? 'interrupted' : undefined;
}

async function has_quarantined_objects<M extends PrunableManifest>(
  target: SnapshotPruneTarget<M>,
): Promise<boolean> {
  for (const prefix of target.quarantine_prefixes) {
    if ((await target.ctx.storage.list(prefix, 1)).length > 0) return true;
  }
  return false;
}

/** The versions of unreferenced keys, until the run is cancelled. */
async function* unreferenced(
  versions: AsyncIterable<PrunableVersion>,
  references: ReferencedKeySet,
  options: SnapshotPruneOptions,
): AsyncGenerator<PrunableVersion> {
  for await (const version of versions) {
    if (is_prune_interrupted(options)) return;
    if (!references.has(version.key)) yield version;
  }
}
