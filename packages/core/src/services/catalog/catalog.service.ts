import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory, TenantContext } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { Manifest, ManifestEntry, OutlookSnapshotSummary } from '@wisecom/atlas-types';
import type {
  CatalogUseCase,
  MailboxSummary,
  OutlookSnapshotListing,
  ReadMessageResult,
} from '@wisecom/atlas-types';
import {
  TENANT_CONTEXT_FACTORY_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  NotFoundError,
} from '@wisecom/atlas-types';
import {
  find_indexed_message,
  load_snapshot_chain,
  message_index_of,
  resolve_message_ref,
} from '@/services/shared/manifest-chain';
import { return_or_raise_partial } from '@/services/shared/unreadable-object-report';
import { merge_snapshot_entries } from '@/services/shared/manifest-entry-merger';
import { build_mailbox_summaries } from '@/services/catalog/mailbox-summary-builder';
import { count_objects_by_snapshot } from '@/services/catalog/snapshot-object-count';

@injectable()
export class CatalogService implements CatalogUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /**
   * Summarises every mailbox from its snapshot summary rows: snapshot count, merged object count,
   * total size and last backup time. Decrypts only manifests the rows do not describe (#726).
   *
   * @throws UnreadableObjectsError naming each damaged manifest, with the summaries of the readable
   *   ones in `partial_result` (issue #631).
   */
  async list_mailboxes(tenant_id: string): Promise<MailboxSummary[]> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = await this._manifests.list_all_snapshot_summaries(ctx);
      const summaries = build_mailbox_summaries(listing.summaries);
      return return_or_raise_partial(listing.unreadable_keys, summaries);
    } finally {
      ctx.destroy();
    }
  }

  /**
   * Returns every manifest for a given mailbox owner, sorted newest-first.
   *
   * @throws UnreadableObjectsError naming each damaged manifest, with the readable ones in
   *   `partial_result` (issue #631).
   */
  async list_snapshots(tenant_id: string, owner_id: string): Promise<Manifest[]> {
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = await this._manifests.list_readable_by_owner(ctx, owner_id);
      const manifests = listing.manifests.sort(
        (a, b) => b.created_at.getTime() - a.created_at.getTime(),
      );
      return return_or_raise_partial(listing.unreadable_keys, manifests);
    } finally {
      ctx.destroy();
    }
  }

  /**
   * Lists a mailbox's snapshots from its summary index, newest first, decrypting only manifests
   * the index has no row for (#625). Each carries the message count of its merged chain (#711).
   *
   * @throws UnreadableObjectsError naming each rowless manifest that could not be read, with the
   *   summaries in `partial_result`.
   */
  async list_snapshot_summaries(
    tenant_id: string,
    owner_id: string,
  ): Promise<OutlookSnapshotListing[]> {
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const listing = await this._manifests.list_snapshot_summaries(ctx, owner_id);
      const listings = with_object_counts(listing.summaries);
      return return_or_raise_partial(listing.unreadable_keys, listings);
    } finally {
      ctx.destroy();
    }
  }

  /** Loads and returns one manifest by snapshot ID. */
  async get_snapshot_detail(tenant_id: string, snapshot_id: string): Promise<Manifest | undefined> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      return await this._manifests.find_by_snapshot(ctx, snapshot_id);
    } finally {
      ctx.destroy();
    }
  }

  /**
   * Finds a message in the snapshot's chain, the same set `restore -s` reads, fetches the
   * encrypted blob from object storage and decrypts it. MIME entries are returned as raw bytes;
   * legacy Graph JSON entries are parsed and returned together with their attachment metadata
   * from the manifest.
   *
   * @param message_ref - Either a 1-based numeric index (e.g. "34") matching the
   *   `atlas list` output, or a full Graph API message ID string.
   */
  async read_message(
    tenant_id: string,
    snapshot_id: string,
    message_ref: string,
  ): Promise<ReadMessageResult | undefined> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const entry = await this.resolve_entry(ctx, snapshot_id, message_ref);
      if (!entry) return undefined;

      const encrypted = await ctx.storage.get(entry.storage_key);
      const raw = ctx.decrypt(encrypted, entry.storage_key);
      if (entry.payload_format === 'mime') {
        return { raw, payload_format: 'mime', attachments: [] };
      }
      const message = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>;
      return { raw, message, attachments: entry.attachments ?? [] };
    } finally {
      ctx.destroy();
    }
  }

  /** Resolves a message in the snapshot's chain; undefined when the snapshot or message is absent. */
  private async resolve_entry(
    ctx: TenantContext,
    snapshot_id: string,
    ref: string,
  ): Promise<ManifestEntry | undefined> {
    const index = message_index_of(ref);
    if (index !== undefined) {
      const target = await this._manifests.find_by_snapshot(ctx, snapshot_id);
      return target ? find_indexed_message(target, index) : undefined;
    }
    let chain: Manifest[];
    try {
      chain = await load_snapshot_chain(this._manifests, ctx, snapshot_id);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
    return resolve_message_ref(chain[0]!, merge_snapshot_entries(chain), ref);
  }
}

/** Adds to each summary row the message count of the chain it heads. */
function with_object_counts(
  summaries: readonly OutlookSnapshotSummary[],
): OutlookSnapshotListing[] {
  const counts = count_objects_by_snapshot(summaries);
  return summaries.map((summary) => ({
    ...summary,
    object_count: counts.get(summary.snapshot_id) ?? 0,
  }));
}
