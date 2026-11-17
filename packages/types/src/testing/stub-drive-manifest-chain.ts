import type { SnapshotSummary } from '@/domain/shared/snapshot-summary';
import type {
  ReadableManifestListing,
  ReadableSnapshotSummaries,
} from '@/ports/storage/readable-listing.port';
import type { TenantContext } from '@/ports/tenant/context.port';

/** What the chain reads need from a drive manifest. */
interface ChainManifest {
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly entries: readonly unknown[];
}

type ReadableListing = (
  ctx: TenantContext,
  owner_id: string,
) => Promise<ReadableManifestListing<ChainManifest>>;

/** A drive repository stub that lists an owner's manifests, by either provider's name. */
interface DriveListingStub {
  readonly list_readable_snapshots_by_owner?: ReadableListing;
  readonly list_readable_snapshots_by_site?: ReadableListing;
}

/** The chain reads `drive_chain_reads` adds to a repository stub. */
export interface DriveChainReads {
  list_snapshot_summaries(
    this: DriveListingStub,
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableSnapshotSummaries<SnapshotSummary>>;
  read_manifest_at(this: DriveListingStub, ctx: TenantContext, key: string): Promise<never>;
}

/**
 * Chain reads for a drive manifest repository stub, answered from the stub's own readable listing
 * at call time. Spread into the stub's object literal: a test that stubs the owner's manifests,
 * even after construction, then also drives the summary-based chain loader (#625).
 */
export function drive_chain_reads(workload: 'onedrive' | 'sharepoint'): DriveChainReads {
  const key_of = (owner_id: string, manifest: ChainManifest): string =>
    `${workload}/manifests/${owner_id}/${manifest.snapshot_id}.json`;
  return {
    async list_snapshot_summaries(ctx, owner_id) {
      const listing = await listing_of(this)(ctx, owner_id);
      return {
        summaries: listing.manifests.map((manifest) => ({
          snapshot_id: manifest.snapshot_id,
          created_at: manifest.created_at,
          manifest_key: key_of(owner_id, manifest),
          entry_count: manifest.entries.length,
          total_size_bytes: 0,
        })),
        unreadable_keys: listing.unreadable_keys,
      };
    },
    async read_manifest_at(ctx, key) {
      const owner_id = key.split('/')[2] ?? '';
      const listing = await listing_of(this)(ctx, owner_id);
      return listing.manifests.find((manifest) => key_of(owner_id, manifest) === key) as never;
    },
  };
}

/** The stub's readable listing, under whichever provider's name it has. */
function listing_of(stub: DriveListingStub): ReadableListing {
  const list = stub.list_readable_snapshots_by_owner ?? stub.list_readable_snapshots_by_site;
  if (!list) throw new Error('drive_chain_reads needs a stub with a readable snapshot listing');
  return list.bind(stub);
}
