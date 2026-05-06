import { injectable } from 'inversify';
import type {
  OneDriveSnapshotManifest,
  OneDriveManifestRepository,
  TenantContext,
} from '@atlas/types';
import {
  onedrive_manifest_key,
  onedrive_manifest_prefix,
  onedrive_manifest_root_prefix,
} from '@/services/onedrive-storage-keys';

/** Persists OneDrive snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3OneDriveManifestRepository implements OneDriveManifestRepository {
  /** Encrypts and uploads a manifest. */
  async save(ctx: TenantContext, manifest: OneDriveSnapshotManifest): Promise<void> {
    const key = onedrive_manifest_key(manifest.owner_id, manifest.snapshot_id);
    const payload = Buffer.from(JSON.stringify(manifest));
    await ctx.storage.put(key, ctx.encrypt(payload));
  }

  /** Searches all owner prefixes for a manifest by snapshot ID. */
  async find_by_snapshot(
    ctx: TenantContext,
    snapshot_id: string,
  ): Promise<OneDriveSnapshotManifest | undefined> {
    const keys = await ctx.storage.list(onedrive_manifest_root_prefix());
    const target_suffix = `/${snapshot_id}.json`;
    const key = keys.find((candidate) => candidate.endsWith(target_suffix));
    if (!key) return undefined;
    return this.download_manifest(ctx, key);
  }

  /** Returns the most recent manifest for an owner. */
  async find_latest_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest | undefined> {
    const manifests = await this.list_snapshots_by_owner(ctx, owner_id);
    return manifests.at(0);
  }

  /** Lists all manifests for an owner, sorted newest first. */
  async list_snapshots_by_owner(
    ctx: TenantContext,
    owner_id: string,
  ): Promise<OneDriveSnapshotManifest[]> {
    const keys = await ctx.storage.list(onedrive_manifest_prefix(owner_id));
    const manifests: OneDriveSnapshotManifest[] = [];
    for (const key of keys) {
      const parsed = await this.download_manifest(ctx, key);
      if (parsed) manifests.push(parsed);
    }
    return manifests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  /** Decrypts and parses a manifest object from storage, or undefined on failure. */
  private async download_manifest(
    ctx: TenantContext,
    key: string,
  ): Promise<OneDriveSnapshotManifest | undefined> {
    try {
      const payload = await ctx.storage.get(key);
      const json = ctx.decrypt(payload).toString('utf-8');
      const parsed = JSON.parse(json) as OneDriveSnapshotManifest;
      return { ...parsed, created_at: new Date(parsed.created_at) };
    } catch {
      return undefined;
    }
  }
}
