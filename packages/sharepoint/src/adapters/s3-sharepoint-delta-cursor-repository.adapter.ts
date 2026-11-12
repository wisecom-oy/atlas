import { injectable } from 'inversify';
import type {
  SharePointDeltaCursor,
  SharePointDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  load_encrypted_json_bound_to_key,
  state_names_key_check,
} from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { sharepoint_delta_cursor_key } from '@/services/shared/storage-keys';

/** Persists the delta sync cursor (delta links + change tracking state) in S3. */
@injectable()
export class S3SharePointDeltaCursorRepository implements SharePointDeltaCursorRepository {
  /** Loads the cursor; undefined only if none exists, throws if it is unreadable or another site's. */
  async load(ctx: TenantContext, site_id: string): Promise<SharePointDeltaCursor | undefined> {
    return load_encrypted_json_bound_to_key<SharePointDeltaCursor>(
      ctx,
      sharepoint_delta_cursor_key(site_id),
      key_cursor_names,
    );
  }

  /** Stores the cursor state, overwriting the previous one, and reads it back. */
  async save(ctx: TenantContext, cursor: SharePointDeltaCursor): Promise<void> {
    await write_encrypted_json(
      ctx,
      {
        key: sharepoint_delta_cursor_key(cursor.site_id),
        label: 'SharePoint delta cursor',
        reader_check: state_names_key_check(key_cursor_names),
        write: 'overwrite',
        confirm_read_back: true,
      },
      cursor,
    );
  }
}

/** The key a cursor body claims to live under. */
function key_cursor_names(cursor: SharePointDeltaCursor): string {
  return sharepoint_delta_cursor_key(cursor.site_id);
}
