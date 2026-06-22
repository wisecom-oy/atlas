import { injectable } from 'inversify';
import type { Manifest } from '@atlas/types';
import type { ManifestRepository } from '@atlas/types';
import type { TenantContext } from '@atlas/types';
import type { StorageObjectLockPolicy } from '@atlas/types';

const MANIFEST_PREFIX = 'manifests';

/** Constructs the S3 key for a manifest. */
function manifest_key(owner_id: string, snapshot_id: string): string {
  return `${MANIFEST_PREFIX}/${owner_id}/${snapshot_id}.json`;
}

/**
 * Stores manifests as encrypted JSON in the tenant's S3 bucket.
 * Key layout: manifests/{owner_id}/{snapshot_id}.json
 */
@injectable()
export class S3ManifestRepository implements ManifestRepository {
  /** Serializes, encrypts, and uploads a manifest. */
  async save(ctx: TenantContext, manifest: Manifest): Promise<void> {
    const key = manifest_key(manifest.owner_id, manifest.snapshot_id);
    const json = Buffer.from(JSON.stringify(manifest));
    const encrypted = ctx.encrypt(json);
    const object_lock_policy = to_storage_object_lock_policy(manifest);
    await ctx.storage.put(key, encrypted, undefined, object_lock_policy);
  }

  /** Searches all mailbox prefixes for a manifest matching the snapshot ID. */
  async find_by_snapshot(ctx: TenantContext, snapshot_id: string): Promise<Manifest | undefined> {
    const all_keys = await ctx.storage.list(`${MANIFEST_PREFIX}/`);
    const target_suffix = `/${snapshot_id}.json`;
    const match = all_keys.find((k) => k.endsWith(target_suffix));

    if (!match) return undefined;
    return this.download_and_decrypt(ctx, match);
  }

  /**
   * Lists manifests for a mailbox owner, parses their created_at timestamps,
   * and returns the most recent one.
   */
  async find_latest_by_owner(ctx: TenantContext, owner_id: string): Promise<Manifest | undefined> {
    const prefix = `${MANIFEST_PREFIX}/${owner_id}/`;
    const keys = await ctx.storage.list(prefix);

    if (keys.length === 0) return undefined;

    let latest: Manifest | undefined;

    for (const key of keys) {
      const manifest = await this.download_and_decrypt(ctx, key);
      if (!manifest) continue;

      const is_newer =
        !latest || new Date(manifest.created_at).getTime() > new Date(latest.created_at).getTime();
      if (is_newer) {
        latest = manifest;
      }
    }

    return latest;
  }

  /** Downloads and decrypts every manifest in the tenant bucket. */
  async list_all_manifests(ctx: TenantContext): Promise<Manifest[]> {
    const keys = await ctx.storage.list(`${MANIFEST_PREFIX}/`);
    const results: Manifest[] = [];

    for (const key of keys) {
      const manifest = await this.download_and_decrypt(ctx, key);
      if (manifest) results.push(manifest);
    }

    return results;
  }

  /** Downloads an encrypted manifest blob, decrypts it, and parses the JSON. */
  private async download_and_decrypt(
    ctx: TenantContext,
    key: string,
  ): Promise<Manifest | undefined> {
    try {
      const encrypted = await ctx.storage.get(key);
      const json = ctx.decrypt(encrypted);
      return JSON.parse(json.toString('utf-8')) as Manifest;
    } catch {
      return undefined;
    }
  }
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
