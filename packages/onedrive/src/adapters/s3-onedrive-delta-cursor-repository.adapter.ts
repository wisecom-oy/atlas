import { injectable } from 'inversify';
import type {
  OneDriveDeltaCursor,
  OneDriveDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { onedrive_delta_cursor_key } from '@/services/onedrive-storage-keys';

/** Persists the delta sync cursor (delta links + change tracking state) in S3. */
@injectable()
export class S3OneDriveDeltaCursorRepository implements OneDriveDeltaCursorRepository {
  /** Loads the cursor; returns undefined if no cursor exists yet. */
  async load(ctx: TenantContext, owner_id: string): Promise<OneDriveDeltaCursor | undefined> {
    const key = onedrive_delta_cursor_key(owner_id);
    const exists = await ctx.storage.exists(key);
    if (!exists) return undefined;

    try {
      const payload = await ctx.storage.get(key);
      const json = ctx.decrypt(payload).toString('utf-8');
      return JSON.parse(json) as OneDriveDeltaCursor;
    } catch {
      return undefined;
    }
  }

  /** Encrypts and stores the cursor state. */
  async save(ctx: TenantContext, cursor: OneDriveDeltaCursor): Promise<void> {
    const key = onedrive_delta_cursor_key(cursor.owner_id);
    const payload = Buffer.from(JSON.stringify(cursor));
    await ctx.storage.put(key, ctx.encrypt(payload));
  }
}
