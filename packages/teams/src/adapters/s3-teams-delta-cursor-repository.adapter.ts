import { injectable } from 'inversify';
import type {
  TeamsDeltaCursor,
  TeamsDeltaCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { TEAMS_KEYS } from '@/services/shared/storage-keys';
import { assert_readable_format_version } from '@/services/shared/format-version';

/** Persists each team's delta cursor as one encrypted JSON object. */
@injectable()
export class S3TeamsDeltaCursorRepository implements TeamsDeltaCursorRepository {
  /** Loads the team's cursor, or undefined when none was saved yet. */
  async load(ctx: TenantContext, team_id: string): Promise<TeamsDeltaCursor | undefined> {
    const key = TEAMS_KEYS.delta_cursor_key(team_id);
    const cursor = await load_encrypted_json<TeamsDeltaCursor>(ctx, key);
    if (cursor) assert_readable_format_version(key, cursor.format_version);
    return cursor;
  }

  /** Encrypts and saves the cursor. */
  async save(ctx: TenantContext, cursor: TeamsDeltaCursor): Promise<void> {
    const key = TEAMS_KEYS.delta_cursor_key(cursor.team_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(cursor)), key));
  }
}
