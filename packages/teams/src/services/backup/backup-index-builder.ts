import {
  TEAMS_FORMAT_VERSION,
  type FailedItemLedger,
  type TeamsChannelCursor,
  type TeamsChannelIndexEntry,
  type TeamsChannelShard,
  type TeamsGraphResource,
  type TeamsSnapshotIndex,
  type TeamsStoredBlobRef,
} from '@wisecom/atlas-types';
import { message_thread_blobs } from '@/services/shared/thread-blobs';

/** The team-level fields of a snapshot index, supplied by the orchestrator. */
export interface TeamIndexInput {
  readonly tenant_id: string;
  readonly team_id: string;
  readonly team_display_name: string | undefined;
  readonly snapshot_id: string;
  readonly created_at: Date;
  readonly team: TeamsGraphResource;
  readonly members: TeamsGraphResource[];
  readonly channels: TeamsChannelIndexEntry[];
}

/** The fields of a per-channel cursor, supplied by the orchestrator. */
export interface ChannelCursorInput {
  readonly team_id: string;
  readonly channel_id: string;
  readonly delta_link: string | undefined;
  readonly baseline_shard_key: string;
  readonly failed_roots: FailedItemLedger;
  readonly updated_at: string;
}

/**
 * Builds a channel's index entry from its saved shard. A thread counts its root plus its replies,
 * and size is the sum of the channel's message blobs.
 */
export function build_channel_index_entry(
  shard: TeamsChannelShard,
  stored: TeamsStoredBlobRef,
): TeamsChannelIndexEntry {
  const threads = Object.values(shard.threads);
  return {
    channel_id: shard.channel_id,
    display_name:
      typeof shard.channel.displayName === 'string' ? shard.channel.displayName : undefined,
    shard_key: stored.storage_key,
    shard_checksum: stored.checksum,
    thread_count: threads.length,
    message_count: sum_of(threads, (thread) => 1 + Object.keys(thread.replies).length),
    size_bytes: sum_of(threads, (thread) =>
      sum_of(message_thread_blobs(thread), (blob) => blob.size_bytes),
    ),
  };
}

/** Builds the team snapshot index. Totals are summed from the channel entries. */
export function build_team_index(input: TeamIndexInput): TeamsSnapshotIndex {
  return {
    id: `${input.team_id}-${input.snapshot_id}`,
    format_version: TEAMS_FORMAT_VERSION,
    tenant_id: input.tenant_id,
    team_id: input.team_id,
    team_display_name: input.team_display_name,
    snapshot_id: input.snapshot_id,
    created_at: input.created_at,
    team: input.team,
    members: input.members,
    channels: input.channels,
    totals: {
      thread_count: sum_of(input.channels, (channel) => channel.thread_count),
      message_count: sum_of(input.channels, (channel) => channel.message_count),
      size_bytes: sum_of(input.channels, (channel) => channel.size_bytes),
    },
  };
}

/** Builds a channel cursor bound to the shard its delta link was read against. */
export function build_channel_cursor(input: ChannelCursorInput): TeamsChannelCursor {
  return {
    format_version: TEAMS_FORMAT_VERSION,
    team_id: input.team_id,
    channel_id: input.channel_id,
    delta_link: input.delta_link,
    baseline_shard_key: input.baseline_shard_key,
    failed_roots: input.failed_roots,
    updated_at: input.updated_at,
  };
}

function sum_of<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((sum, item) => sum + value(item), 0);
}
