import {
  TEAMS_FORMAT_VERSION,
  type TeamsChannelIndexEntry,
  type TeamsChannelShard,
  type TeamsSnapshotIndex,
} from '@wisecom/atlas-types';
import type { SavedMessage, SavedThread } from '@/services/save/thread-views';

/** A channel selected for export, with the folder its files are written under. */
export interface ExportedChannel {
  readonly entry: TeamsChannelIndexEntry;
  readonly folder: string;
}

const NAME_MAX_LENGTH = 60;
const ID_PREFIX_LENGTH = 12;

/**
 * The archive folder for one channel: a readable name plus the start of its id, so two channels
 * with the same display name never share a folder. Only ASCII letters and digits survive, which
 * rules out path separators and dot segments.
 */
export function channel_folder_name(channel_id: string, display_name: string | undefined): string {
  const name = (display_name ?? '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, NAME_MAX_LENGTH)
    .replace(/-+$/, '');
  const id_prefix = channel_id.replace(/[^A-Za-z0-9]/g, '').slice(0, ID_PREFIX_LENGTH);
  return `${name === '' ? 'channel' : name}-${id_prefix}`;
}

/** Top-level `team.json`: the snapshot's team and members, and the channels this archive holds. */
export function team_document(index: TeamsSnapshotIndex, channels: ExportedChannel[]): string {
  const document = {
    format_version: TEAMS_FORMAT_VERSION,
    snapshot_id: index.snapshot_id,
    created_at: index.created_at,
    team: index.team,
    members: index.members,
    channels: channels.map(({ entry, folder }) => ({
      channel_id: entry.channel_id,
      display_name: entry.display_name,
      folder,
      thread_count: entry.thread_count,
      message_count: entry.message_count,
      deleted_at: entry.deleted_at,
    })),
  };
  return JSON.stringify(document, null, 2);
}

/**
 * Per-channel `messages.json`: the channel with its members, tabs, files folder and shared-with
 * teams as the shard stored them, then every thread with its messages. `members_from_team` means
 * the members are the team's, listed in `team.json`.
 */
export function channel_document(
  team_id: string,
  shard: TeamsChannelShard,
  threads: SavedThread[],
): string {
  const document = {
    format_version: TEAMS_FORMAT_VERSION,
    team_id,
    channel_id: shard.channel_id,
    channel: shard.channel,
    members_from_team: shard.members_from_team === true,
    members: shard.members,
    tabs: shard.tabs,
    shared_with_teams: shard.shared_with_teams ?? null,
    files_folder: shard.files_folder ?? null,
    files_folder_unavailable: shard.files_folder_unavailable === true,
    threads: threads.map((thread) => ({
      root: message_entry(thread.root),
      replies: thread.replies.map(message_entry),
    })),
  };
  return JSON.stringify(document, null, 2);
}

function message_entry(message: SavedMessage): Record<string, unknown> {
  return {
    id: message.id,
    deleted_at: message.deleted_at,
    kept_version: message.kept_version,
    message: message.content,
    hosted: message.hosted,
    hosted_missing: message.hosted_missing,
  };
}
