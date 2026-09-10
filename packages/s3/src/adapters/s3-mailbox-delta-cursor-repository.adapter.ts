import { injectable } from 'inversify';
import type {
  MailboxDeltaCursor,
  MailboxDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';

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
  /** Loads the cursor; undefined before the first save, or when it cannot be read. */
  async load(ctx: TenantContext, owner_id: string): Promise<MailboxDeltaCursor | undefined> {
    const key = cursor_key(owner_id);
    if (!(await ctx.storage.exists(key))) return undefined;

    try {
      const payload = await ctx.storage.get(key);
      return JSON.parse(ctx.decrypt(payload, key).toString('utf-8')) as MailboxDeltaCursor;
    } catch {
      // An unreadable cursor is not fatal: the manifest links are still there to fall back on,
      // and the worst case is one re-enumeration.
      return undefined;
    }
  }

  /** Encrypts and stores the cursor. */
  async save(ctx: TenantContext, cursor: MailboxDeltaCursor): Promise<void> {
    const key = cursor_key(cursor.owner_id);
    const payload = Buffer.from(JSON.stringify(cursor));
    await ctx.storage.put(key, ctx.encrypt(payload, key));
  }
}
