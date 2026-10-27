import { normalize_owner_id } from '@/services/shared/identifier-normalization';
import { inject, injectable } from 'inversify';
import type { TenantContextFactory } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { Manifest } from '@wisecom/atlas-types';
import type { MailboxSummary, ReadMessageResult, CatalogUseCase } from '@wisecom/atlas-types';
import { TENANT_CONTEXT_FACTORY_TOKEN, MANIFEST_REPOSITORY_TOKEN } from '@wisecom/atlas-types';
import { merge_snapshot_entries } from '@/services/shared/manifest-entry-merger';

@injectable()
export class CatalogService implements CatalogUseCase {
  constructor(
    @inject(TENANT_CONTEXT_FACTORY_TOKEN) private readonly _tenant_factory: TenantContextFactory,
    @inject(MANIFEST_REPOSITORY_TOKEN) private readonly _manifests: ManifestRepository,
  ) {}

  /**
   * Groups all manifests by mailbox, picking the latest per mailbox
   * for summary stats (object count, size, last backup time).
   */
  async list_mailboxes(tenant_id: string): Promise<MailboxSummary[]> {
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const all = await this._manifests.list_all_manifests(ctx);
      const by_mailbox = group_by_mailbox(all);
      return build_mailbox_summaries(by_mailbox);
    } finally {
      ctx.destroy();
    }
  }

  /** Returns every manifest for a given mailbox owner, sorted newest-first. */
  async list_snapshots(tenant_id: string, owner_id: string): Promise<Manifest[]> {
    owner_id = normalize_owner_id(owner_id);
    const ctx = await this._tenant_factory.create_readonly(tenant_id);
    try {
      const manifests = await this._manifests.list_by_owner(ctx, owner_id);
      return manifests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
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
   * Finds a message entry in the manifest, fetches the encrypted blob
   * from object storage and decrypts it. MIME entries are returned as raw
   * bytes; legacy Graph JSON entries are parsed and returned together with
   * their attachment metadata from the manifest.
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
      const manifest = await this._manifests.find_by_snapshot(ctx, snapshot_id);
      if (!manifest) return undefined;

      const entry = this.resolve_entry(manifest, message_ref);
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

  /** Resolves a manifest entry by 1-based index or by object_id. */
  private resolve_entry(manifest: Manifest, ref: string): Manifest['entries'][number] | undefined {
    const index = Number(ref);
    if (Number.isInteger(index) && index >= 1) {
      return manifest.entries[index - 1];
    }
    return manifest.entries.find((e) => e.object_id === ref);
  }
}

/** Groups manifests into a map keyed by owner_id. */
function group_by_mailbox(manifests: Manifest[]): Map<string, Manifest[]> {
  const map = new Map<string, Manifest[]>();
  for (const m of manifests) {
    const arr = map.get(m.owner_id) ?? [];
    arr.push(m);
    map.set(m.owner_id, arr);
  }
  return map;
}

/**
 * Builds one MailboxSummary per group. The object count is the latest snapshot's merged chain,
 * so messages a later run recorded as removed are not counted (issue #536). total_size_bytes sums
 * every snapshot, since each incremental snapshot only stores newly arrived data.
 * mailbox_purpose comes from the newest manifest that recorded one, so a
 * transient lookup failure in the latest backup does not blank the type.
 */
function build_mailbox_summaries(groups: Map<string, Manifest[]>): MailboxSummary[] {
  const summaries: MailboxSummary[] = [];

  for (const [owner_id, manifests] of groups) {
    manifests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    const latest = manifests[0]!;
    const purpose = manifests.find((m) => m.mailbox_purpose)?.mailbox_purpose;
    const owner_email = manifests.find((m) => m.owner_email)?.owner_email;
    const cumulative_size = manifests.reduce((sum, m) => sum + m.total_size_bytes, 0);

    summaries.push({
      owner_id,
      ...(owner_email ? { owner_email } : {}),
      ...(purpose ? { mailbox_purpose: purpose } : {}),
      snapshot_count: manifests.length,
      total_objects: merge_snapshot_entries(manifests).length,
      total_size_bytes: cumulative_size,
      last_backup_at: latest.created_at,
    });
  }

  return summaries.sort((a, b) => a.owner_id.localeCompare(b.owner_id));
}
