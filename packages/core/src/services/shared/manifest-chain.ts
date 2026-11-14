import type {
  Manifest,
  ManifestEntry,
  ManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { NotFoundError, UnreadableObjectsError } from '@wisecom/atlas-types';
import { read_each_readable } from '@/services/shared/readable-object-listing';

const CHAIN_READ_CONCURRENCY = 8;

/**
 * Loads a snapshot's manifest plus every older manifest of the same mailbox, target first, then
 * newest-first. An Outlook manifest holds only that run's delta, so this chain is what a snapshot
 * actually contains. Verify, restore and save all read it, so the three cannot drift (issue #432).
 * Only the target's own `manifests/{owner_id}/` prefix is read, never the whole tenant (issue #510),
 * and the mailbox's summary index picks the older manifests, so newer ones are never decrypted
 * (#625).
 */
export async function load_snapshot_chain(
  manifests: ManifestRepository,
  ctx: TenantContext,
  snapshot_id: string,
): Promise<Manifest[]> {
  const target = await manifests.find_by_snapshot(ctx, snapshot_id);
  if (!target) throw new NotFoundError(`No manifest found for snapshot ${snapshot_id}`);
  return [target, ...(await load_older_manifests(manifests, ctx, target))];
}

/**
 * Reads the manifests the summary index places at or before the target, newest first, refusing
 * when one the chain may need is damaged.
 *
 * A damaged manifest without a row has its `created_at` inside the ciphertext, and an Outlook
 * snapshot id carries no time, so nothing says whether it is older than the target. If it is, the
 * target's chain needs it: its messages, and the removals that hide deleted ones, exist nowhere
 * else. Leaving it out would restore a different mailbox than the one backed up, so the chain is
 * refused with every damaged key named rather than resolved without them (issue #631).
 */
export async function load_older_manifests(
  manifests: ManifestRepository,
  ctx: TenantContext,
  target: Manifest,
): Promise<Manifest[]> {
  const listing = await manifests.list_snapshot_summaries(ctx, target.owner_id);
  if (listing.unreadable_keys.length > 0) {
    throw chain_refusal(target.snapshot_id, listing.unreadable_keys);
  }
  const cutoff = target.created_at.getTime();
  const older_keys = listing.summaries
    .filter((s) => s.snapshot_id !== target.snapshot_id && s.created_at.getTime() <= cutoff)
    .map((s) => s.manifest_key);
  const read = await read_each_readable(
    older_keys,
    (key) => manifests.read_manifest_at(ctx, key),
    CHAIN_READ_CONCURRENCY,
  );
  if (read.unreadable_keys.length > 0) {
    throw chain_refusal(target.snapshot_id, read.unreadable_keys, read.unreadable_errors[0]);
  }
  return read.items.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
}

/** The error a chain that may need damaged manifests is refused with. */
function chain_refusal(snapshot_id: string, keys: string[], cause?: Error): UnreadableObjectsError {
  return new UnreadableObjectsError(
    `Snapshot ${snapshot_id} cannot be resolved: its chain may need a damaged Outlook manifest`,
    keys,
    cause ? { cause } : undefined,
  );
}

/**
 * Finds a message in a snapshot's merged chain. A 1-based index counts the target manifest, the
 * list `outlook list -s` prints, so an index never means a different message between commands. An
 * `object_id` matches anywhere in the chain, which is how a message carried over from an earlier
 * run is addressed. `merged` comes from `merge_snapshot_entries`, so removed messages never match.
 */
export function resolve_message_ref(
  target: Manifest,
  merged: ManifestEntry[],
  ref: string,
): ManifestEntry | undefined {
  const index = message_index_of(ref);
  const object_id = index !== undefined ? target.entries[index - 1]?.object_id : ref;
  return merged.find((e) => e.object_id === object_id);
}

/** The 1-based message index a reference names, or undefined when it is a message ID. */
export function message_index_of(ref: string): number | undefined {
  const index = Number(ref);
  return Number.isInteger(index) && index >= 1 ? index : undefined;
}

/**
 * Finds the message a 1-based index names, from the target manifest alone. The target heads its
 * merged chain and its own entries win over its removals, so the merge would return this entry
 * too: an index never needs the older manifests (#625).
 */
export function find_indexed_message(target: Manifest, index: number): ManifestEntry | undefined {
  const object_id = target.entries[index - 1]?.object_id;
  return object_id === undefined
    ? undefined
    : target.entries.find((e) => e.object_id === object_id);
}
