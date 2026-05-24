import { injectable } from 'inversify';
import type {
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  TenantContext,
} from '@atlas/types';
import { sharepoint_delta_cursor_key } from '@/services/sharepoint-storage-keys';

/** Persists the delta sync cursor (delta links + change tracking state) in S3. */
@injectable()
export class S3SharePointDeltaCursorRepository implements SharePointDeltaCursorRepository {
  /** Loads the cursor; returns undefined if no cursor exists yet. */
  async load(ctx: TenantContext, site_id: string): Promise<SharePointDeltaCursor | undefined> {
    const key = sharepoint_delta_cursor_key(site_id);
    const exists = await ctx.storage.exists(key);
    if (!exists) return undefined;

    try {
      const payload = await ctx.storage.get(key);
      const json = ctx.decrypt(payload).toString('utf-8');
      return JSON.parse(json) as SharePointDeltaCursor;
    } catch {
      return undefined;
    }
  }

  /** Encrypts and stores the cursor state. */
  async save(ctx: TenantContext, cursor: SharePointDeltaCursor): Promise<void> {
    const key = sharepoint_delta_cursor_key(cursor.site_id);
    const payload = Buffer.from(JSON.stringify(cursor));
    await ctx.storage.put(key, ctx.encrypt(payload));
  }
}
