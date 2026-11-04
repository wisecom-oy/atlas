import { injectable } from 'inversify';
import type {
  TeamsChannelCursor,
  TeamsChannelCursorRepository,
  TenantContext,
} from '@wisecom/atlas-types';
import { UnreadableContentError } from '@wisecom/atlas-types';
import { load_encrypted_json } from '@wisecom/atlas-core/services/shared/encrypted-state-reader';
import { assert_readable_format_version } from '@/services/shared/format-version';
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

  /** Loads every cursor of a team. The first damaged or newer-format cursor raises. */
  async list(ctx: TenantContext, team_id: string): Promise<TeamsChannelCursor[]> {
    const cursors: TeamsChannelCursor[] = [];
    for (const key of await ctx.storage.list(teams_cursor_prefix_for(team_id))) {
      const cursor = await this.read(ctx, key);
      if (cursor) cursors.push(cursor);
    }
    return cursors;
  }

  /** Reads one cursor and rejects a body that does not name the key it was read from. */
  private async read(ctx: TenantContext, key: string): Promise<TeamsChannelCursor | undefined> {
    const cursor = await load_encrypted_json<TeamsChannelCursor>(ctx, key);
    if (cursor === undefined) return undefined;
    assert_readable_format_version(key, cursor.format_version);
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
