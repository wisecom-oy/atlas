import { injectable } from 'inversify';
import type {
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { sharepoint_delta_cursor_key } from '@/services/shared/storage-keys';

/** Persists the delta sync cursor (delta links + change tracking state) in S3. */
@injectable()
export class S3SharePointDeltaCursorRepository implements SharePointDeltaCursorRepository {
  /** Loads the cursor; undefined only if none exists, throws if one exists and cannot be read. */
  async load(ctx: TenantContext, site_id: string): Promise<SharePointDeltaCursor | undefined> {
    return load_encrypted_json<SharePointDeltaCursor>(ctx, sharepoint_delta_cursor_key(site_id));
  }

  /** Encrypts and stores the cursor state. */
  async save(ctx: TenantContext, cursor: SharePointDeltaCursor): Promise<void> {
    const key = sharepoint_delta_cursor_key(cursor.site_id);
    const payload = Buffer.from(JSON.stringify(cursor));
    await ctx.storage.put(key, ctx.encrypt(payload, key));
  }
}
