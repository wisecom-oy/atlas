import { injectable } from 'inversify';
import type {
  SharePointSnapshotManifest,
  SharePointManifestRepository,
  TenantContext,
} from '@atlas/types';
import {
  sharepoint_manifest_key,
  sharepoint_manifest_prefix,
} from '@/services/sharepoint-storage-keys';

class InvalidSharePointManifestDateError extends Error {
  constructor(readonly storage_key: string) {
    super(`Invalid created_at in SharePoint manifest at ${storage_key}`);
    this.name = 'InvalidSharePointManifestDateError';
  }
}

/** Persists SharePoint snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3SharePointManifestRepository implements SharePointManifestRepository {
  /** Encrypts and uploads a manifest. */
  async save(ctx: TenantContext, manifest: SharePointSnapshotManifest): Promise<void> {
    const key = sharepoint_manifest_key(manifest.site_id, manifest.snapshot_id);
    const payload = Buffer.from(JSON.stringify(manifest));
    await ctx.storage.put(key, ctx.encrypt(payload));
  }

  /** Loads a manifest by listing only that site's manifest prefix. */
  async find_by_snapshot(
    ctx: TenantContext,
    site_id: string,
    snapshot_id: string,
  ): Promise<SharePointSnapshotManifest | undefined> {
    const expected_key = sharepoint_manifest_key(site_id, snapshot_id);
    const keys = await ctx.storage.list(sharepoint_manifest_prefix(site_id));
    const key = keys.find((candidate) => candidate === expected_key);
    if (!key) return undefined;
    return this.download_manifest(ctx, key);
  }

  /** Returns the most recent manifest for a site. */
  async find_latest_by_site(
    ctx: TenantContext,
    site_id: string,
  ): Promise<SharePointSnapshotManifest | undefined> {
    const manifests = await this.list_snapshots_by_site(ctx, site_id);
    return manifests.at(0);
  }

  /** Lists all manifests for a site, sorted newest first. */
  async list_snapshots_by_site(
    ctx: TenantContext,
    site_id: string,
  ): Promise<SharePointSnapshotManifest[]> {
    const keys = await ctx.storage.list(sharepoint_manifest_prefix(site_id));
    const manifests: SharePointSnapshotManifest[] = [];
    for (const key of keys) {
      const parsed = await this.download_manifest(ctx, key);
      if (parsed) manifests.push(parsed);
    }
    return manifests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  private async download_manifest(
    ctx: TenantContext,
    key: string,
  ): Promise<SharePointSnapshotManifest | undefined> {
    try {
      const payload = await ctx.storage.get(key);
      const json = ctx.decrypt(payload).toString('utf-8');
      const parsed = JSON.parse(json) as SharePointSnapshotManifest;
      const created_at = new Date(parsed.created_at);
      if (Number.isNaN(created_at.getTime())) {
        throw new InvalidSharePointManifestDateError(key);
      }
      return { ...parsed, created_at };
    } catch (err) {
      if (err instanceof InvalidSharePointManifestDateError) throw err;
      return undefined;
    }
  }
}
