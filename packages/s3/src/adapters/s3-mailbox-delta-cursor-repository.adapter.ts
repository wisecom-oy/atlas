import { injectable } from 'inversify';
import type {
  MailboxDeltaCursor,
  MailboxDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import {
  load_encrypted_json_bound_to_key,
  state_names_key_check,
} from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { write_encrypted_json } from '@wisecom/atlas-core/services/shared/stored-json-writer';

const CURSOR_PREFIX = '_meta/outlook-cursors';

/** Constructs the S3 key for a mailbox's delta cursor. */
function cursor_key(owner_id: string): string {
  return `${CURSOR_PREFIX}/${owner_id}.json`;
}

/**
 * Persists a mailbox's folder delta links as one encrypted object the run overwrites.
 *
 * The links used to live in the snapshot manifest, which made a run that changed nothing write a
 * whole snapshot object just to record them. Snapshots are immutable once written, so this is a
 * separate object rather than a rewrite of the head (issue #370).
 */
@injectable()
export class S3MailboxDeltaCursorRepository implements MailboxDeltaCursorRepository {
  /**
   * Loads the cursor; undefined only before the first save.
   *
   * A cursor that cannot be fetched, decrypted or parsed, or that belongs to another owner, throws.
   * Every cursor shares one directory, so the envelope does not stop another mailbox's cursor from
   * decrypting here, and reading a damaged one as absent would fall back to the manifest links and
   * hide the delta links a failed run withheld (issue #622).
   */
  async load(ctx: TenantContext, owner_id: string): Promise<MailboxDeltaCursor | undefined> {
    return load_encrypted_json_bound_to_key<MailboxDeltaCursor>(
      ctx,
      cursor_key(owner_id),
      key_cursor_names,
    );
  }

  /** Stores the cursor, overwriting the previous one, and reads it back. */
  async save(ctx: TenantContext, cursor: MailboxDeltaCursor): Promise<void> {
    await write_encrypted_json(
      ctx,
      {
        key: cursor_key(cursor.owner_id),
        label: 'Outlook delta cursor',
        reader_check: state_names_key_check(key_cursor_names),
        write: 'overwrite',
        confirm_read_back: true,
      },
      cursor,
    );
  }
}

/** The key a cursor body claims to live under. */
function key_cursor_names(cursor: MailboxDeltaCursor): string {
  return cursor_key(cursor.owner_id);
}
