import { injectable } from 'inversify';
import type {
  OneDriveSnapshotManifest,
  OneDriveManifestRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  onedrive_manifest_key,
  onedrive_manifest_prefix,
  onedrive_manifest_root_prefix,
} from '@/services/shared/storage-keys';
import { StorageError } from '@wisecom/atlas-types';
import { is_absent_object_error } from '@wisecom/atlas-core/services/shared/absent-object';

class InvalidOneDriveManifestDateError extends Error {
  constructor(readonly storage_key: string) {
    super(`Invalid created_at in OneDrive manifest at ${storage_key}`);
    this.name = 'InvalidOneDriveManifestDateError';
  }
}

class MismatchedOneDriveManifestError extends Error {
  constructor(
    readonly storage_key: string,
    owner_id: string,
    snapshot_id: string,
  ) {
    super(
      `OneDrive manifest at ${storage_key} decrypts to ${owner_id}/${snapshot_id}; ` +
        `refusing to use a manifest that is not the one the key names`,
    );
    this.name = 'MismatchedOneDriveManifestError';
  }
}

/** Persists OneDrive snapshot manifests as encrypted JSON in S3. */
@injectable()
export class S3OneDriveManifestRepository implements OneDriveManifestRepository {
  /** Encrypts and uploads a manifest. */
  async save(ctx: TenantContext, manifest: OneDriveSnapshotManifest): Promise<void> {
    const key = onedrive_manifest_key(manifest.owner_id, manifest.snapshot_id);
    const payload = Buffer.from(JSON.stringify(manifest));
    await ctx.storage.put(key, ctx.encrypt(payload));
  }

  /** Loads a manifest by listing only that owner's manifest prefix. */
  async find_by_snapshot(
    ctx: TenantContext,
    owner_id: string,
    snapshot_id: string,
  ): Promise<OneDriveSnapshotManifest | undefined> {
    const expected_key = onedrive_manifest_key(owner_id, snapshot_id);
    const keys = await ctx.storage.list(onedrive_manifest_prefix(owner_id));
    const key = keys.find((candidate) => candidate === expected_key);
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

  /** Lists every manifest across all owners, sorted newest first. */
  async list_all_manifests(ctx: TenantContext): Promise<OneDriveSnapshotManifest[]> {
    const keys = await ctx.storage.list(onedrive_manifest_root_prefix());
    const manifests: OneDriveSnapshotManifest[] = [];
    for (const key of keys) {
      const parsed = await this.download_manifest(ctx, key);
      if (parsed) manifests.push(parsed);
    }
    return manifests.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }

  /**
   * Downloads one manifest, rejecting a body that is not the identity the key names.
   *
   * A manifest is encrypted with the tenant key and nothing in the ciphertext says which manifest
   * it is, so any manifest in the tenant authenticates at any other manifest's key. Rebuilding the
   * key from the decrypted body and comparing it to the key that was read is what distinguishes
   * them, and it covers every lookup here rather than only the one that had an id to check
   * (issue #340).
   */
  private async download_manifest(
    ctx: TenantContext,
    key: string,
  ): Promise<OneDriveSnapshotManifest | undefined> {
    try {
      const payload = await ctx.storage.get(key);
      const json = ctx.decrypt(payload).toString('utf-8');
      const parsed = JSON.parse(json) as OneDriveSnapshotManifest;
      if (onedrive_manifest_key(parsed.owner_id, parsed.snapshot_id) !== key) {
        throw new MismatchedOneDriveManifestError(key, parsed.owner_id, parsed.snapshot_id);
      }
      const created_at = new Date(parsed.created_at);
      if (Number.isNaN(created_at.getTime())) {
        throw new InvalidOneDriveManifestDateError(key);
      }
      return { ...parsed, created_at };
    } catch (err) {
      // Absence is the only recoverable outcome. A manifest that failed to decrypt, parse or
      // identify is damaged, and returning `undefined` for it reports a broken backup with the
      // same value as a snapshot that was never taken (issues #340, #341).
      if (is_absent_object_error(err)) return undefined;
      if (err instanceof InvalidOneDriveManifestDateError) throw err;
      if (err instanceof MismatchedOneDriveManifestError) throw err;
      throw new StorageError(`Could not read the OneDrive manifest at ${key}`, { cause: err });
    }
  }
}
