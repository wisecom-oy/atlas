import {
  load_encrypted_json_bound_to_key,
  state_names_key_check,
} from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';
import type {
  CalendarDeltaCursor,
  CalendarDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { injectable } from 'inversify';
import { calendar_delta_cursor_key } from '@/services/shared/storage-keys';

/** Persists per-calendar event delta links as one encrypted JSON object per mailbox. */
@injectable()
export class S3CalendarDeltaCursorRepository implements CalendarDeltaCursorRepository {
  /** Loads the mailbox's delta cursor; undefined when none was saved, throws if unreadable or another mailbox's. */
  async load(ctx: TenantContext, mailbox_id: string): Promise<CalendarDeltaCursor | undefined> {
    return load_encrypted_json_bound_to_key<CalendarDeltaCursor>(
      ctx,
      calendar_delta_cursor_key(mailbox_id),
      key_cursor_names,
    );
  }

  /** Stores the mailbox's delta cursor, overwriting the previous one, and reads it back. */
  async save(ctx: TenantContext, cursor: CalendarDeltaCursor): Promise<void> {
    await write_encrypted_json(
      ctx,
      {
        key: calendar_delta_cursor_key(cursor.mailbox_id),
        label: 'calendar delta cursor',
        reader_check: state_names_key_check(key_cursor_names),
        write: 'overwrite',
        confirm_read_back: true,
      },
      cursor,
    );
  }
}

/** The key a cursor body claims to live under. */
function key_cursor_names(cursor: CalendarDeltaCursor): string {
  return calendar_delta_cursor_key(cursor.mailbox_id);
}
