import { injectable } from 'inversify';
import { logger } from '@atlas/core/utils/logger';
import type {
  SharePointFileVersionIndex,
  SharePointFileVersionRecord,
  SharePointFileVersionIndexRepository,
  TenantContext,
} from '@atlas/types';
import { sharepoint_index_key, sharepoint_index_prefix } from '@/services/sharepoint-storage-keys';

const MAX_APPEND_RETRIES = 3;

/** Persists per-file version history as encrypted JSON in S3. */
@injectable()
export class S3SharePointFileVersionIndexRepository implements SharePointFileVersionIndexRepository {
  private readonly _key_locks = new Map<string, Promise<unknown>>();

  /** Retrieves the version index for a specific file. */
  async find_by_file_id(
    ctx: TenantContext,
    site_id: string,
    file_id: string,
  ): Promise<SharePointFileVersionIndex | undefined> {
    const key = sharepoint_index_key(site_id, file_id);
    const exists = await ctx.storage.exists(key);
    if (!exists) return undefined;
    return this.download_index(ctx, key);
  }

  /**
   * Appends a version record and persists the updated index.
   * Uses per-key serialization + S3 conditional put to prevent races.
   */
  async append_version(
    ctx: TenantContext,
    site_id: string,
    file_id: string,
    version: SharePointFileVersionRecord,
  ): Promise<SharePointFileVersionIndex> {
    const key = sharepoint_index_key(site_id, file_id);
    return this.with_key_lock(key, () =>
      this.append_version_serialized(ctx, site_id, file_id, version),
    );
  }

  /** Lists all file version indexes for a site. */
  async list_by_site(ctx: TenantContext, site_id: string): Promise<SharePointFileVersionIndex[]> {
    const keys = await ctx.storage.list(sharepoint_index_prefix(site_id));
    const results: SharePointFileVersionIndex[] = [];
    for (const key of keys) {
      const idx = await this.download_index(ctx, key);
      if (idx) results.push(idx);
    }
    return results;
  }

  private async append_version_serialized(
    ctx: TenantContext,
    site_id: string,
    file_id: string,
    version: SharePointFileVersionRecord,
  ): Promise<SharePointFileVersionIndex> {
    const key = sharepoint_index_key(site_id, file_id);

    for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
      const existing = await ctx.storage.exists(key);
      let current_versions: SharePointFileVersionRecord[] = [];
      let etag: string | undefined;

      if (existing) {
        const result = await ctx.storage.get_with_etag(key);
        const json = ctx.decrypt(result.data).toString('utf-8');
        const parsed = JSON.parse(json) as SharePointFileVersionIndex;
        current_versions = parsed.versions;
        etag = result.etag;
      }

      const next: SharePointFileVersionIndex = {
        file_id,
        site_id,
        versions: [...current_versions, version],
      };

      try {
        const payload = Buffer.from(JSON.stringify(next));
        await ctx.storage.put(key, ctx.encrypt(payload), undefined, undefined, etag);
        return next;
      } catch (err) {
        const is_precondition = (err as { name?: string }).name === 'PreconditionFailedError';
        if (!is_precondition || attempt === MAX_APPEND_RETRIES - 1) {
          throw new Error(`append_version failed for ${file_id} after ${attempt + 1} attempts`);
        }
        logger.debug(`Version index ETag conflict for ${file_id}, retry ${attempt + 1}`);
      }
    }
    throw new Error('append_version: unreachable');
  }

  private async download_index(
    ctx: TenantContext,
    key: string,
  ): Promise<SharePointFileVersionIndex | undefined> {
    try {
      const payload = await ctx.storage.get(key);
      const json = ctx.decrypt(payload).toString('utf-8');
      return JSON.parse(json) as SharePointFileVersionIndex;
    } catch {
      return undefined;
    }
  }

  private async with_key_lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this._key_locks.has(key)) {
      await this._key_locks.get(key);
    }
    const promise = fn();
    this._key_locks.set(
      key,
      promise.catch(() => {}),
    );
    try {
      return await promise;
    } finally {
      this._key_locks.delete(key);
    }
  }
}
