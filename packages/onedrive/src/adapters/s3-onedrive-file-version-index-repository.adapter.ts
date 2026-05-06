import { injectable } from 'inversify';
import type {
  OneDriveFileVersionIndex,
  OneDriveFileVersionRecord,
  OneDriveFileVersionIndexRepository,
  TenantContext,
} from '@atlas/types';
import { onedrive_index_key, onedrive_index_prefix } from '@/services/onedrive-storage-keys';

/** Persists per-file version history as encrypted JSON in S3. */
@injectable()
export class S3OneDriveFileVersionIndexRepository implements OneDriveFileVersionIndexRepository {
  /** Retrieves the version index for a specific file. */
  async find_by_file_id(
    ctx: TenantContext,
    owner_id: string,
    file_id: string,
  ): Promise<OneDriveFileVersionIndex | undefined> {
    const key = onedrive_index_key(owner_id, file_id);
    const exists = await ctx.storage.exists(key);
    if (!exists) return undefined;
    return this.download_index(ctx, key);
  }

  /** Appends a version record and persists the updated index. */
  async append_version(
    ctx: TenantContext,
    owner_id: string,
    file_id: string,
    version: OneDriveFileVersionRecord,
  ): Promise<OneDriveFileVersionIndex> {
    const current = await this.find_by_file_id(ctx, owner_id, file_id);
    const next: OneDriveFileVersionIndex = {
      file_id,
      owner_id,
      versions: [...(current?.versions ?? []), version],
    };
    await this.save_index(ctx, next);
    return next;
  }

  /** Lists all file version indexes for an owner. */
  async list_by_owner(ctx: TenantContext, owner_id: string): Promise<OneDriveFileVersionIndex[]> {
    const keys = await ctx.storage.list(onedrive_index_prefix(owner_id));
    const results: OneDriveFileVersionIndex[] = [];
    for (const key of keys) {
      const idx = await this.download_index(ctx, key);
      if (idx) results.push(idx);
    }
    return results;
  }

  /** Encrypts and writes a file version index to its object key. */
  private async save_index(ctx: TenantContext, index: OneDriveFileVersionIndex): Promise<void> {
    const key = onedrive_index_key(index.owner_id, index.file_id);
    const payload = Buffer.from(JSON.stringify(index));
    await ctx.storage.put(key, ctx.encrypt(payload));
  }

  /** Decrypts and parses an index object from storage, or undefined on failure. */
  private async download_index(
    ctx: TenantContext,
    key: string,
  ): Promise<OneDriveFileVersionIndex | undefined> {
    try {
      const payload = await ctx.storage.get(key);
      const json = ctx.decrypt(payload).toString('utf-8');
      return JSON.parse(json) as OneDriveFileVersionIndex;
    } catch {
      return undefined;
    }
  }
}
