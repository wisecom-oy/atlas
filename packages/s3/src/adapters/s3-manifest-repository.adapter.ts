import { injectable } from 'inversify';
import type { Manifest } from '@wisecom/atlas-types';
import type { ManifestRepository } from '@wisecom/atlas-types';
import type { TenantContext } from '@wisecom/atlas-types';
import type { StorageObjectLockPolicy } from '@wisecom/atlas-types';

const MANIFEST_PREFIX = 'manifests';
const MANIFEST_POINTER_PREFIX = '_meta/outlook-manifests';
const MANIFEST_READ_CONCURRENCY = 8;

interface ManifestPointer {
  readonly manifest_key: string;
}

/** Constructs the S3 key for a manifest. */
function manifest_key(owner_id: string, snapshot_id: string): string {
  return `${MANIFEST_PREFIX}/${owner_id}/${snapshot_id}.json`;
}

function latest_pointer_key(owner_id: string): string {
  return `${MANIFEST_POINTER_PREFIX}/owners/${owner_id}/latest.json`;
}

function snapshot_pointer_key(snapshot_id: string): string {
  return `${MANIFEST_POINTER_PREFIX}/snapshots/${snapshot_id}.json`;
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

    const pointer = ctx.encrypt(
      Buffer.from(JSON.stringify({ manifest_key: key } satisfies ManifestPointer)),
    );
    await Promise.all([
      ctx.storage.put(snapshot_pointer_key(manifest.snapshot_id), pointer),
      ctx.storage.put(latest_pointer_key(manifest.owner_id), pointer),
    ]);
  }

  /** Loads a manifest through its snapshot index, with a legacy layout fallback. */
  async find_by_snapshot(ctx: TenantContext, snapshot_id: string): Promise<Manifest | undefined> {
    const target_suffix = `/${snapshot_id}.json`;
    const indexed_key = await this.download_pointer(ctx, snapshot_pointer_key(snapshot_id));
    if (indexed_key?.endsWith(target_suffix)) {
      const indexed_manifest = await this.download_and_decrypt(ctx, indexed_key);
      if (indexed_manifest?.snapshot_id === snapshot_id) return indexed_manifest;
    }

    const all_keys = await ctx.storage.list(`${MANIFEST_PREFIX}/`);
    const match = all_keys.find((key) => key.endsWith(target_suffix));
    if (!match) return undefined;
    return this.download_and_decrypt(ctx, match);
  }

  /** Returns the indexed latest manifest, with a legacy layout fallback. */
  async find_latest_by_owner(ctx: TenantContext, owner_id: string): Promise<Manifest | undefined> {
    const prefix = `${MANIFEST_PREFIX}/${owner_id}/`;
    const indexed_key = await this.download_pointer(ctx, latest_pointer_key(owner_id));
    if (indexed_key?.startsWith(prefix)) {
      const indexed_manifest = await this.download_and_decrypt(ctx, indexed_key);
      if (indexed_manifest?.owner_id === owner_id) return indexed_manifest;
    }

    const keys = await ctx.storage.list(prefix);
    if (keys.length === 0) return undefined;

    const manifests = await this.download_manifests(ctx, keys);
    let latest: Manifest | undefined;
    for (const manifest of manifests) {
      const is_newer =
        !latest || new Date(manifest.created_at).getTime() > new Date(latest.created_at).getTime();
      if (is_newer) latest = manifest;
    }
    return latest;
  }

  /** Downloads every manifest with bounded storage concurrency. */
  async list_all_manifests(ctx: TenantContext): Promise<Manifest[]> {
    const keys = await ctx.storage.list(`${MANIFEST_PREFIX}/`);
    return this.download_manifests(ctx, keys);
  }

  private async download_pointer(ctx: TenantContext, key: string): Promise<string | undefined> {
    try {
      const encrypted = await ctx.storage.get(key);
      const json = ctx.decrypt(encrypted);
      const parsed = JSON.parse(json.toString('utf-8')) as Partial<ManifestPointer>;
      return typeof parsed.manifest_key === 'string' ? parsed.manifest_key : undefined;
    } catch {
      return undefined;
    }
  }

  private async download_manifests(ctx: TenantContext, keys: string[]): Promise<Manifest[]> {
    const results = new Array<Manifest | undefined>(keys.length);
    let next_index = 0;

    const run_worker = async (): Promise<void> => {
      while (next_index < keys.length) {
        const index = next_index;
        next_index++;
        results[index] = await this.download_and_decrypt(ctx, keys[index]!);
      }
    };

    const worker_count = Math.min(MANIFEST_READ_CONCURRENCY, keys.length);
    await Promise.all(Array.from({ length: worker_count }, run_worker));
    return results.filter((manifest): manifest is Manifest => manifest !== undefined);
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
