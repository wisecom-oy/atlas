import { injectable } from 'inversify';
import type {
  MailboxDeltaCursor,
  MailboxDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { load_encrypted_json_bound_to_key } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';

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
    return load_encrypted_json_bound_to_key<MailboxDeltaCursor>(ctx, cursor_key(owner_id), (c) =>
      cursor_key(c.owner_id),
    );
  }

  /** Encrypts and stores the cursor. */
  async save(ctx: TenantContext, cursor: MailboxDeltaCursor): Promise<void> {
    const key = cursor_key(cursor.owner_id);
    const payload = Buffer.from(JSON.stringify(cursor));
    await ctx.storage.put(key, ctx.encrypt(payload, key));
  }
}
