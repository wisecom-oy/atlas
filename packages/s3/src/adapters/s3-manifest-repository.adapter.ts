import { injectable } from 'inversify';
import type { Manifest } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { TenantContext, TenantStorageContext } from '@wisecom/atlas-types';
import type {
  HeldOwnerLease,
  LatestReadableManifest,
  OutlookSnapshotSummary,
  ReadableManifestListing,
  ReadableSnapshotSummaries,
  StorageObjectLockPolicy,
} from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import {
  read_each_readable,
  require_every_object_readable,
  type ReadableObjects,
} from '@wisecom/atlas-core/services/shared/readable-object-listing';
import {
  OUTLOOK_MANIFEST_PREFIX,
  outlook_manifest_key,
  read_outlook_manifest,
  require_outlook_manifest,
} from '@/adapters/outlook-manifest-reader';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { forget_snapshot_summary_or_warn } from '@wisecom/atlas-core/services/shared/snapshot-summary-pruner';
import {
  list_snapshot_summaries,
  list_tenant_snapshot_summaries,
} from '@wisecom/atlas-core/services/shared/snapshot-summary-reader';
import { record_snapshot_summary_or_warn } from '@wisecom/atlas-core/services/shared/snapshot-summary-writer';
import {
  OUTLOOK_SUMMARY_LAYOUT,
  summarize_outlook_manifest,
} from '@/adapters/outlook-snapshot-summary-layout';
import {
  latest_pointer_key,
  pointer_manifest_key,
  read_latest_pointer,
  snapshot_pointer_key,
  write_latest_pointer_unless_newer,
  write_manifest_pointer,
  type ManifestPointer,
} from '@/adapters/outlook-manifest-pointers';

const MANIFEST_READ_CONCURRENCY = 8;

/**
 * Stores manifests as encrypted JSON in the tenant's S3 bucket.
 * Key layout: manifests/{owner_id}/{snapshot_id}.json
 */
@injectable()
export class S3ManifestRepository implements ManifestRepository {
  /**
   * Stores a manifest, then the two pointers that name it, then its row in the mailbox's summary
   * index. The manifest write is create-only, refused when `require_outlook_manifest` would reject
   * the body, and read back once it lands; nothing after it runs unless it succeeded. The latest
   * pointer is kept when it names a newer snapshot (issue #741). `lease` is checked again right
   * before the summary write.
   */
  async save(ctx: TenantContext, manifest: Manifest, lease?: HeldOwnerLease): Promise<void> {
    const key = outlook_manifest_key(manifest.owner_id, manifest.snapshot_id);
    await write_encrypted_json(
      ctx,
      {
        key,
        label: 'Outlook manifest',
        reader_check: require_outlook_manifest,
        write: 'create_only',
        confirm_read_back: true,
        object_lock_policy: to_storage_object_lock_policy(manifest),
      },
      manifest,
    );

    // Encrypted once per destination: the two pointers live in different directories, and the
    // binding is what stops one being moved onto the other (issue #350).
    const snapshot_pointer: ManifestPointer = { manifest_key: key };
    await Promise.all([
      write_manifest_pointer(ctx, snapshot_pointer_key(manifest.snapshot_id), snapshot_pointer),
      write_latest_pointer_unless_newer(ctx, manifest, key),
    ]);
    await record_snapshot_summary_or_warn(
      ctx,
      OUTLOOK_SUMMARY_LAYOUT,
      manifest.owner_id,
      summarize_outlook_manifest(manifest, key),
      lease,
    );
  }

  /** Drops a removed snapshot's row from the mailbox's summary index; logs instead of failing. */
  async forget_snapshot_summary(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
    lease?: HeldOwnerLease,
  ): Promise<void> {
    await forget_snapshot_summary_or_warn(
      ctx,
      OUTLOOK_SUMMARY_LAYOUT,
      owner_id,
      snapshot_id,
      lease,
    );
  }

  /** Lists one owner's snapshots from its summary index, decrypting only rowless manifests. */
  async list_snapshot_summaries(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableSnapshotSummaries<OutlookSnapshotSummary>> {
    return list_snapshot_summaries(ctx, OUTLOOK_SUMMARY_LAYOUT, owner_id);
  }

  /** Lists every mailbox's snapshots from their summary indexes, decrypting only rowless manifests. */
  async list_all_snapshot_summaries(
    ctx: TenantContext,
  ): Promise<ReadableSnapshotSummaries<OutlookSnapshotSummary>> {
    return list_tenant_snapshot_summaries(ctx, OUTLOOK_SUMMARY_LAYOUT);
  }

  /** Loads a manifest through its snapshot index, with a legacy layout fallback. */
  async find_by_snapshot(ctx: TenantContext, snapshot_id: string): Promise<Manifest | undefined> {
    const target_suffix = `/${snapshot_id}.json`;
    const indexed_key = await this.download_pointer(ctx, snapshot_pointer_key(snapshot_id));
    if (indexed_key?.endsWith(target_suffix)) {
      const indexed_manifest = await read_outlook_manifest(ctx, indexed_key);
      if (indexed_manifest?.snapshot_id === snapshot_id) return indexed_manifest;
    }

    const all_keys = await ctx.storage.list(`${OUTLOOK_MANIFEST_PREFIX}/`);
    const match = all_keys.find((key) => key.endsWith(target_suffix));
    if (!match) return undefined;
    return read_outlook_manifest(ctx, match);
  }

  /**
   * Returns the newest readable manifest of an owner. The latest pointer answers with one read;
   * when the manifest it names is damaged, the owner's prefix is read in full and the newest
   * readable manifest is returned with every damaged key it found (issue #631).
   */
  async find_latest_readable(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<LatestReadableManifest<Manifest>> {
    const prefix = `${OUTLOOK_MANIFEST_PREFIX}/${owner_id}/`;
    const indexed_key = await read_latest_pointer(ctx, latest_pointer_key(owner_id));
    if (indexed_key?.startsWith(prefix)) {
      const indexed = await read_if_readable(ctx, indexed_key);
      if (indexed?.owner_id === owner_id) return { manifest: indexed, unreadable_keys: [] };
    }

    const listing = await this.read_keys(ctx, await ctx.storage.list(prefix));
    return { manifest: newest(listing.items), unreadable_keys: listing.unreadable_keys };
  }

  /** Downloads one owner's manifests, raising when any of them is damaged. */
  async list_by_owner(ctx: TenantContext, owner_id: string): Promise<Manifest[]> {
    const listing = await this.read_keys(ctx, await this.owner_keys(ctx, owner_id));
    return require_every_object_readable(listing, 'Outlook manifest(s) of this mailbox');
  }

  /** Lists one owner's readable manifests and the keys of the damaged ones. */
  async list_readable_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<ReadableManifestListing<Manifest>> {
    return as_listing(await this.read_keys(ctx, await this.owner_keys(ctx, owner_id)));
  }

  /** Downloads every manifest with bounded storage concurrency, raising when any is damaged. */
  async list_all_manifests(ctx: TenantContext): Promise<Manifest[]> {
    const listing = await this.read_keys(
      ctx,
      await ctx.storage.list(`${OUTLOOK_MANIFEST_PREFIX}/`),
    );
    return require_every_object_readable(listing, 'Outlook manifest(s)');
  }

  /** Lists every readable manifest in the tenant and the keys of the damaged ones. */
  async list_all_readable(ctx: TenantContext): Promise<ReadableManifestListing<Manifest>> {
    return as_listing(
      await this.read_keys(ctx, await ctx.storage.list(`${OUTLOOK_MANIFEST_PREFIX}/`)),
    );
  }

  /** Reads the manifest at exactly this key; raises when it is damaged. */
  async read_manifest_at(ctx: TenantContext, storage_key: string): Promise<Manifest | undefined> {
    return read_outlook_manifest(ctx, storage_key);
  }

  /** Lists owners from `manifests/{owner_id}/...` key names; one paginated LIST, nothing decrypted. */
  async list_owner_ids(ctx: TenantStorageContext): Promise<string[]> {
    const keys = await ctx.storage.list(`${OUTLOOK_MANIFEST_PREFIX}/`);
    return [...new Set(keys.map((key) => key.split('/')[1]).filter((id): id is string => !!id))];
  }

  private async owner_keys(ctx: TenantContext, owner_id: string): Promise<string[]> {
    return ctx.storage.list(`${OUTLOOK_MANIFEST_PREFIX}/${owner_id}/`);
  }

  private async read_keys(ctx: TenantContext, keys: string[]): Promise<ReadableObjects<Manifest>> {
    return read_each_readable(
      keys,
      (key) => read_outlook_manifest(ctx, key),
      MANIFEST_READ_CONCURRENCY,
    );
  }

  private async download_pointer(ctx: TenantContext, key: string): Promise<string | undefined> {
    try {
      const encrypted = await ctx.storage.get(key);
      const json = ctx.decrypt(encrypted, key);
      return pointer_manifest_key(JSON.parse(json.toString('utf-8')));
    } catch {
      return undefined;
    }
  }
}

/** Reads one manifest, treating damage as "not usable here" so the caller falls back to a scan. */
async function read_if_readable(ctx: TenantContext, key: string): Promise<Manifest | undefined> {
  try {
    return await read_outlook_manifest(ctx, key);
  } catch (err) {
    if (err instanceof UnreadableContentError) return undefined;
    throw err;
  }
}

function newest(manifests: readonly Manifest[]): Manifest | undefined {
  let latest: Manifest | undefined;
  for (const manifest of manifests) {
    const is_newer = !latest || manifest.created_at.getTime() > latest.created_at.getTime();
    if (is_newer) latest = manifest;
  }
  return latest;
}

function as_listing(listing: ReadableObjects<Manifest>): ReadableManifestListing<Manifest> {
  return { manifests: listing.items, unreadable_keys: listing.unreadable_keys };
}

function to_storage_object_lock_policy(manifest: Manifest): StorageObjectLockPolicy | undefined {
  if (!manifest.object_lock?.effective) return undefined;
  const effective = manifest.object_lock.effective;
  if (!effective.retain_until) return undefined;
  return {
    mode: effective.mode,
    retain_until: effective.retain_until,
  };
}
