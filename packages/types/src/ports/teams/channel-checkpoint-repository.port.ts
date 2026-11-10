import type {
  TeamsChannelCheckpointHead,
  TeamsChannelCheckpointHostedEntry,
  TeamsChannelCheckpointSegment,
} from '@/domain/teams/checkpoint';
import type { TenantContext } from '@/ports/tenant/context.port';

/**
 * Resume state of channel reads that were interrupted. One object per channel head, one object per
 * segment, and one object per hosted-journal entry, so a checkpoint write never rewrites
 * accumulated state.
 */
export interface TeamsChannelCheckpointRepository {
  /**
   * Loads one channel's checkpoint head, or undefined when none exists.
   *
   * @throws UnreadableContentError when the head is damaged. Callers treat that as absent.
   * @throws UnsupportedFormatVersionError when the head was written by a newer format version.
   */
  load_head(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsChannelCheckpointHead | undefined>;

  /** Loads one segment named in a head. @throws UnreadableContentError when it is damaged. */
  load_segment(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
  ): Promise<TeamsChannelCheckpointSegment>;

  /** Writes one segment. Segments are written before the head that names them. */
  save_segment(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
    segment: TeamsChannelCheckpointSegment,
  ): Promise<void>;

  /** Writes the channel's head. */
  save_head(ctx: TenantContext, head: TeamsChannelCheckpointHead): Promise<void>;

  /** Writes one hosted-journal entry as its own object. The head is not rewritten. */
  save_hosted_entry(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
    name: string,
    entry: TeamsChannelCheckpointHostedEntry,
  ): Promise<void>;

  /**
   * Loads every hosted-journal entry of one channel's checkpoint, in no particular order.
   *
   * @throws UnreadableContentError when an entry is damaged.
   */
  load_hosted_entries(
    ctx: TenantContext,
    team_id: string,
    channel_id: string,
  ): Promise<TeamsChannelCheckpointHostedEntry[]>;

  /** Deletes every object of one channel's checkpoint (head, segments, and hosted entries). */
  delete_channel(ctx: TenantContext, team_id: string, channel_id: string): Promise<void>;
}
