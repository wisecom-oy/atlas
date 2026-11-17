import {
  type TeamsChannelShard,
  type TeamsChannelShardRepository,
  type TenantContext,
} from '@wisecom/atlas-types';
import { error_message } from '@/services/shared/error-message';
import { channel_document, type ExportedChannel } from '@/services/save/archive-layout';
import { render_channel_page } from '@/services/save/html/channel-page';
import type {
  ArchiveEntrySink,
  ExportTally,
  ThreadExportContext,
} from '@/services/save/export-types';
import { by_created_at, load_saved_thread, type SavedThread } from '@/services/save/thread-views';

/**
 * Writes the entries of one channel: each hosted file as it is read, then `messages.json` and
 * `index.html`. Returns false when the shard cannot be read: the failure goes to the tally and the
 * channel is left out of the archive.
 */
export async function export_channel(
  ctx: TenantContext,
  shards: TeamsChannelShardRepository,
  team_id: string,
  exported: ExportedChannel,
  tally: ExportTally,
  write: ArchiveEntrySink,
): Promise<boolean> {
  const { entry, folder } = exported;
  let shard: TeamsChannelShard;
  try {
    // ponytail: the whole channel shard is held in memory. Stream one thread at a time if channels
    // outgrow RAM.
    shard = await shards.load(ctx, entry.shard_key);
  } catch (err) {
    tally.errors.push(`channel ${folder}: ${error_message(err)}`);
    return false;
  }
  const directory = `channels/${folder}`;
  const threads = await load_threads({ ctx, directory, write, tally }, shard);
  const title = shard.channel.displayName ?? entry.display_name ?? entry.channel_id;
  await write(
    `${directory}/messages.json`,
    Buffer.from(channel_document(team_id, shard, threads), 'utf8'),
  );
  await write(`${directory}/index.html`, Buffer.from(render_channel_page(title, threads), 'utf8'));
  return true;
}

async function load_threads(
  context: ThreadExportContext,
  shard: TeamsChannelShard,
): Promise<SavedThread[]> {
  const threads: SavedThread[] = [];
  for (const [root_id, thread] of Object.entries(shard.threads)) {
    const saved = await load_saved_thread(context, root_id, thread);
    if (saved !== undefined) threads.push(saved);
  }
  return threads.sort((a, b) => by_created_at(a.root, b.root));
}
