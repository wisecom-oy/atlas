import { injectable } from 'inversify';
import type {
  OneDriveDeltaCursor,
  OneDriveDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  load_encrypted_json_bound_to_key,
  state_names_key_check,
} from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import { onedrive_delta_cursor_key } from '@/services/shared/storage-keys';

/** Persists the delta sync cursor (delta links + change tracking state) in S3. */
@injectable()
export class S3OneDriveDeltaCursorRepository implements OneDriveDeltaCursorRepository {
  /** Loads the cursor; undefined only if none exists, throws if it is unreadable or another owner's. */
  async load(ctx: TenantContext, owner_id: string): Promise<OneDriveDeltaCursor | undefined> {
    return load_encrypted_json_bound_to_key<OneDriveDeltaCursor>(
      ctx,
      onedrive_delta_cursor_key(owner_id),
      key_cursor_names,
    );
  }

  /** Stores the cursor state, overwriting the previous one, and reads it back. */
  async save(ctx: TenantContext, cursor: OneDriveDeltaCursor): Promise<void> {
    await write_encrypted_json(
      ctx,
      {
        key: onedrive_delta_cursor_key(cursor.owner_id),
        label: 'OneDrive delta cursor',
        reader_check: state_names_key_check(key_cursor_names),
        write: 'overwrite',
        confirm_read_back: true,
      },
      cursor,
    );
  }
}

/** The key a cursor body claims to live under. */
function key_cursor_names(cursor: OneDriveDeltaCursor): string {
  return onedrive_delta_cursor_key(cursor.owner_id);
}
