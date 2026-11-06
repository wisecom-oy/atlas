import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import type {
  ContactsDeltaCursor,
  ContactsDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { injectable } from 'inversify';
import { contacts_delta_cursor_key } from '@/services/shared/storage-keys';

/** Persists per-folder contact delta links as one encrypted JSON object per mailbox. */
@injectable()
export class S3ContactsDeltaCursorRepository implements ContactsDeltaCursorRepository {
  /** Loads the mailbox's delta cursor, or undefined when none has been saved. */
  async load(ctx: TenantContext, mailbox_id: string): Promise<ContactsDeltaCursor | undefined> {
    return load_encrypted_json<ContactsDeltaCursor>(ctx, contacts_delta_cursor_key(mailbox_id));
  }

  /** Encrypts and stores the mailbox's delta cursor. */
  async save(ctx: TenantContext, cursor: ContactsDeltaCursor): Promise<void> {
    const key = contacts_delta_cursor_key(cursor.mailbox_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(cursor)), key));
  }
}
