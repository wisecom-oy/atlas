import { injectable } from 'inversify';
import type {
  TeamsChannelCursor,
  TeamsChannelCursorRepository,
  TeamsCursorScan,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableContentError, UnsupportedFormatVersionError } from '@wisecom/atlas-types';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { assert_cursor_shape } from '@/services/shared/teams-object-shape';
import { teams_cursor_key, teams_cursor_prefix_for } from '@/services/shared/storage-keys';

/** Persists each channel's delta cursor as one encrypted JSON object. */
@injectable()
export class S3TeamsChannelCursorRepository implements TeamsChannelCursorRepository {
  /** Loads one channel's cursor, or undefined when none was saved yet. */
  async load(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsChannelCursor | undefined> {
    return this.read(ctx, teams_cursor_key(team_id, channel_id));
  }

  /** Encrypts and saves one channel's cursor under its team and channel key. */
  async save(ctx: TenantContext, cursor: TeamsChannelCursor): Promise<void> {
    const key = teams_cursor_key(cursor.team_id, cursor.channel_id);
    await ctx.storage.put(key, ctx.encrypt(Buffer.from(JSON.stringify(cursor)), key));
  }

  /** Reads every cursor of a team, sorting damaged and newer-format keys into their own lists. */
  async scan(ctx: TenantContext, team_id: string): Promise<TeamsCursorScan> {
    const scan: TeamsCursorScan = { cursors: [], unreadable_keys: [], unsupported_keys: [] };
    for (const key of await ctx.storage.list(teams_cursor_prefix_for(team_id))) {
      try {
        const cursor = await this.read(ctx, key);
        if (cursor) scan.cursors.push(cursor);
      } catch (err) {
        if (err instanceof UnsupportedFormatVersionError) scan.unsupported_keys.push(key);
        else if (err instanceof UnreadableContentError) scan.unreadable_keys.push(key);
        else throw err;
      }
    }
    return scan;
  }

  /** Reads one cursor and rejects a body that does not name the key it was read from. */
  private async read(ctx: TenantContext, key: string): Promise<TeamsChannelCursor | undefined> {
    const cursor = await load_encrypted_json<unknown>(ctx, key);
    if (cursor === undefined) return undefined;
    assert_cursor_shape(key, cursor);
    if (!names_key(cursor, key)) {
      throw new UnreadableContentError(
        `The Teams channel cursor at ${key} names a different team or channel than its key`,
      );
    }
    return cursor;
  }
}

/** Whether a cursor body names the key it was read from. */
function names_key(cursor: TeamsChannelCursor, key: string): boolean {
  try {
    return teams_cursor_key(cursor.team_id, cursor.channel_id) === key;
  } catch {
    return false;
  }
}
