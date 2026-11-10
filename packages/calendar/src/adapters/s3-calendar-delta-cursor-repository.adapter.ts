import { load_encrypted_json_bound_to_key } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
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
      (cursor) => calendar_delta_cursor_key(cursor.mailbox_id),
    );
  }

  /** Encrypts and stores the mailbox's delta cursor. */
  async save(ctx: TenantContext, cursor: CalendarDeltaCursor): Promise<void> {
    const key = calendar_delta_cursor_key(cursor.mailbox_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(cursor)), key));
  }
}
