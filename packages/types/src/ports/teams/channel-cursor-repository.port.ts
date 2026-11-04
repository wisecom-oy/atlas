import type { TeamsChannelCursor } from '@/domain/teams-manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

/** The readable cursors of one team, and the keys of the damaged or newer-format ones the scan skipped. */
export interface TeamsCursorScan {
  readonly cursors: TeamsChannelCursor[];
  readonly unreadable_keys: string[];
  readonly unsupported_keys: string[];
}

/** Per-channel delta cursors. One object per channel, so a channel's state never rewrites another's. */
export interface TeamsChannelCursorRepository {
  /**
   * Loads one channel's cursor, or undefined when none exists.
   *
   * @throws UnreadableContentError when the cursor is damaged. Callers may treat that as absent,
   *   since a missing cursor only costs a full read.
   * @throws UnsupportedFormatVersionError when the cursor was written by a newer format version.
   */
  load(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsChannelCursor | undefined>;

  /** Saves one channel's cursor. Call only after the index that lists its shard is durable. */
  save(ctx: TenantContext, cursor: TeamsChannelCursor): Promise<void>;

  /** Reads every cursor of a team, reporting damaged or newer-format keys instead of throwing. */
  scan(ctx: TenantContext, team_id: string): Promise<TeamsCursorScan>;
}
