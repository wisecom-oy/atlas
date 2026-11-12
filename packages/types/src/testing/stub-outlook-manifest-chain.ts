import type { Manifest } from '@/domain/outlook/manifest';
import type { OutlookSnapshotSummary } from '@/domain/shared/snapshot-summary';
import type { ManifestRepository } from '@/ports/storage/manifest-repository.port';
import type { ReadableSnapshotSummaries } from '@/ports/storage/readable-listing.port';
import type { TenantContext } from '@/ports/tenant/context.port';

type OwnerListing = Pick<ManifestRepository, 'list_by_owner'>;

/** The key an Outlook manifest is stored under. */
function outlook_key(manifest: Manifest): string {
  return `manifests/${manifest.owner_id}/${manifest.snapshot_id}.json`;
}

/** The summary row an Outlook manifest would have. */
export function outlook_summary_row(manifest: Manifest): OutlookSnapshotSummary {
  return {
    snapshot_id: manifest.snapshot_id,
    created_at: manifest.created_at,
    manifest_key: outlook_key(manifest),
    entry_count: manifest.entries.length,
    total_size_bytes: manifest.total_size_bytes,
    owner_id: manifest.owner_id,
    total_objects: manifest.total_objects,
    removed_count: manifest.removed_object_ids?.length ?? 0,
  };
}

/**
 * Answers `list_snapshot_summaries` for a repository stub from its `list_by_owner` stub, so a test
 * that stubs an owner's manifests also drives the chain loader. A listing that raises
 * `UnreadableObjectsError` becomes rowless damaged keys, which is what the summary reader reports.
 */
export async function summaries_from_owner_listing(
  repo: OwnerListing,
  ctx: TenantContext,
  owner_id: string,
): Promise<ReadableSnapshotSummaries<OutlookSnapshotSummary>> {
  try {
    const manifests = await repo.list_by_owner(ctx, owner_id);
    return { summaries: manifests.map(outlook_summary_row), unreadable_keys: [] };
  } catch (err) {
    const unreadable_keys = unreadable_keys_of(err);
    if (!unreadable_keys) throw err;
    return { summaries: [], unreadable_keys };
  }
}

/**
 * The keys an `UnreadableObjectsError` names, read by shape: test helpers import types only, since
 * a value import through the `@/` alias does not resolve from another package's tests.
 */
function unreadable_keys_of(err: unknown): string[] | undefined {
  const keys = (err as { unreadable_keys?: unknown } | undefined)?.unreadable_keys;
  return Array.isArray(keys) ? keys.map(String) : undefined;
}

/**
 * The chain reads of a repository stub, answered from its own `list_by_owner` stub. `repo` is a
 * getter so the stub can pass itself from inside its own object literal.
 */
export function outlook_chain_reads(
  repo: () => OwnerListing,
): Pick<ManifestRepository, 'list_snapshot_summaries' | 'read_manifest_at'> {
  return {
    list_snapshot_summaries: (ctx, owner_id) => summaries_from_owner_listing(repo(), ctx, owner_id),
    read_manifest_at: (ctx, key) => manifest_from_owner_listing(repo(), ctx, key),
  };
}

/** The chain reads `outlook_stub_chain_reads` adds to a repository stub. */
export interface OutlookStubChainReads {
  list_snapshot_summaries(
    this: OwnerListing,
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableSnapshotSummaries<OutlookSnapshotSummary>>;
  read_manifest_at(
    this: OwnerListing,
    ctx: TenantContext,
    key: string,
  ): Promise<Manifest | undefined>;
}

/**
 * The same chain reads as methods that answer from the stub they are called on, for spreading
 * into an inline stub literal that has no name to pass to `outlook_chain_reads`.
 */
export function outlook_stub_chain_reads(): OutlookStubChainReads {
  return {
    list_snapshot_summaries(ctx, owner_id) {
      return summaries_from_owner_listing(this, ctx, owner_id);
    },
    read_manifest_at(ctx, key) {
      return manifest_from_owner_listing(this, ctx, key);
    },
  };
}

/** Answers `read_manifest_at` for a repository stub from its `list_by_owner` stub. */
export async function manifest_from_owner_listing(
  repo: OwnerListing,
  ctx: TenantContext,
  key: string,
): Promise<Manifest | undefined> {
  const [, owner_id] = key.split('/');
  if (!owner_id) return undefined;
  const manifests = await repo.list_by_owner(ctx, owner_id);
  return manifests.find((manifest) => outlook_key(manifest) === key);
}
