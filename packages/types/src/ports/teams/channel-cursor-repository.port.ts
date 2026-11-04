import type { TeamsChannelCursor } from '@/domain/teams-manifest';
import type { TenantContext } from '@/ports/tenant/context.port';

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

  /** Lists every cursor of a team. Throws on the first damaged or newer-format cursor. */
  list(ctx: TenantContext, team_id: string): Promise<TeamsChannelCursor[]>;
}
