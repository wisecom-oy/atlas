import { injectable } from 'inversify';
import type {
  OneDriveDeltaCursor,
  OneDriveDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { onedrive_delta_cursor_key } from '@/services/shared/storage-keys';

/** Persists the delta sync cursor (delta links + change tracking state) in S3. */
@injectable()
export class S3OneDriveDeltaCursorRepository implements OneDriveDeltaCursorRepository {
  /** Loads the cursor; undefined only if none exists, throws if one exists and cannot be read. */
  async load(ctx: TenantContext, owner_id: string): Promise<OneDriveDeltaCursor | undefined> {
    return load_encrypted_json<OneDriveDeltaCursor>(ctx, onedrive_delta_cursor_key(owner_id));
  }

  /** Encrypts and stores the cursor state. */
  async save(ctx: TenantContext, cursor: OneDriveDeltaCursor): Promise<void> {
    const key = onedrive_delta_cursor_key(cursor.owner_id);
    const payload = Buffer.from(JSON.stringify(cursor));
    await ctx.storage.put(key, ctx.encrypt(payload, key));
  }
}
