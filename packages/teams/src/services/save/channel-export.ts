import {
  type TeamsChannelShard,
  type TeamsChannelShardRepository,
  type TenantContext,
} from '@wisecom/atlas-types';
import { error_message } from '@/services/shared/error-message';
import { channel_document, type ExportedChannel } from '@/services/save/archive-layout';
import { render_channel_page } from '@/services/save/html/channel-page';
import {
  by_created_at,
  load_saved_thread,
  type ExportTally,
  type SavedThread,
} from '@/services/save/thread-views';

/** One file of the archive, by its path inside the zip. */
export interface ArchiveFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Builds the two files of one channel. Returns undefined when the shard cannot be read: the
 * failure goes to the tally and the channel is left out of the archive.
 */
export async function export_channel(
  ctx: TenantContext,
  shards: TeamsChannelShardRepository,
  team_id: string,
  exported: ExportedChannel,
  tally: ExportTally,
): Promise<ArchiveFile[] | undefined> {
  const { entry, folder } = exported;
  let shard: TeamsChannelShard;
  try {
    // ponytail: the whole channel shard is held in memory. Stream one thread at a time if channels
    // outgrow RAM.
    shard = await shards.load(ctx, entry.shard_key);
  } catch (err) {
    tally.errors.push(`channel ${folder}: ${error_message(err)}`);
    return undefined;
  }
  const threads = await load_threads(ctx, shard, tally);
  const title = shard.channel.displayName ?? entry.display_name ?? entry.channel_id;
  const directory = `channels/${folder}`;
  return [
    {
      path: `${directory}/messages.json`,
      content: channel_document(team_id, entry.channel_id, shard.channel, threads),
    },
    { path: `${directory}/index.html`, content: render_channel_page(title, threads) },
  ];
}

async function load_threads(
  ctx: TenantContext,
  shard: TeamsChannelShard,
  tally: ExportTally,
): Promise<SavedThread[]> {
  const threads: SavedThread[] = [];
  for (const [root_id, thread] of Object.entries(shard.threads)) {
    const saved = await load_saved_thread(ctx, root_id, thread, tally);
    if (saved !== undefined) threads.push(saved);
  }
  return threads.sort((a, b) => by_created_at(a.root, b.root));
}
