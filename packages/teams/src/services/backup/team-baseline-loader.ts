import {
  UnreadableContentError,
  UnsupportedFormatVersionError,
  type FailedItemLedger,
  type TeamsChannelCursor,
  type TeamsChannelCursorRepository,
  type TeamsChannelIndexEntry,
  type TeamsIndexRepository,
  type TeamsSnapshotIndex,
  type TenantContext,
} from '@wisecom/atlas-types';
import type { HostedRecheck } from '@/services/backup/hosted-recheck';

/** The ports a run reads its starting state through. */
export interface BaselinePorts {
  readonly indexes: TeamsIndexRepository;
  readonly cursors: TeamsChannelCursorRepository;
}

/** What a run starts from for one channel. */
export interface ChannelBaseline {
  /** The channel's entry in the latest readable index, if it had one. */
  readonly previous_entry: TeamsChannelIndexEntry | undefined;
  /** The stored delta link, only when its cursor was bound to `previous_entry`'s shard. */
  readonly delta_link: string | undefined;
  /** Failed roots from the channel's cursor. Kept even when the link is not usable. */
  readonly failed_roots: FailedItemLedger;
  /** Hosted-content recheck attempts from the channel's cursor. */
  readonly hosted_recheck: HostedRecheck;
}

/** The state a run starts from: the latest readable index and each owned channel's baseline. */
export interface TeamsBaseline {
  readonly previous: TeamsSnapshotIndex | undefined;
  readonly channels: ReadonlyMap<string, ChannelBaseline>;
  readonly errors: string[];
  readonly warnings: string[];
}

/**
 * Loads the latest readable index and each channel's cursor. An index written by a newer format
 * throws before any write, so an older Atlas never overwrites it. An unreadable index or cursor is
 * reported rather than silently treated as absent.
 */
export async function load_team_baseline(
  ctx: TenantContext,
  ports: BaselinePorts,
  team_id: string,
  channel_ids: readonly string[],
): Promise<TeamsBaseline> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const latest = await ports.indexes.find_latest_readable(ctx, team_id);
  if (latest.unsupported_keys.length > 0) {
    throw new UnsupportedFormatVersionError(
      `${latest.unsupported_keys.length} Teams snapshot index(es) were written by a newer Atlas format; upgrade Atlas before backing up this team`,
    );
  }
  for (const key of latest.unreadable_keys) {
    errors.push(`Snapshot ${key} could not be read; its channels were not compared`);
  }
  if (latest.unreadable_keys.length > 0) {
    warnings.push(
      latest.index === undefined
        ? 'No readable snapshot exists; every channel is read in full'
        : 'The baseline is an older snapshot because a newer one could not be read',
    );
  }
  const channels = new Map<string, ChannelBaseline>();
  for (const channel_id of channel_ids) {
    const previous_entry = latest.index?.channels.find((c) => c.channel_id === channel_id);
    const cursor = await load_cursor(ctx, ports.cursors, team_id, channel_id, warnings);
    channels.set(channel_id, {
      previous_entry,
      delta_link: usable_delta_link(cursor, previous_entry, channel_id, warnings),
      failed_roots: cursor?.failed_roots ?? {},
      hosted_recheck: cursor?.hosted_recheck ?? {},
    });
  }
  return { previous: latest.index, channels, errors, warnings };
}

async function load_cursor(
  ctx: TenantContext,
  cursors: TeamsChannelCursorRepository,
  team_id: string,
  channel_id: string,
  warnings: string[],
): Promise<TeamsChannelCursor | undefined> {
  try {
    return await cursors.load(ctx, team_id, channel_id);
  } catch (err) {
    if (!(err instanceof UnreadableContentError)) throw err;
    warnings.push(
      `The cursor for channel ${channel_id} is unreadable; reading the channel in full`,
    );
    return undefined;
  }
}

/**
 * Returns the cursor's delta link only when the cursor was saved against the channel's latest
 * shard. A link from an older shard would skip changes the shard does not hold, so the channel is
 * read in full instead.
 */
function usable_delta_link(
  cursor: TeamsChannelCursor | undefined,
  previous_entry: TeamsChannelIndexEntry | undefined,
  channel_id: string,
  warnings: string[],
): string | undefined {
  if (cursor?.delta_link === undefined) {
    return undefined;
  }
  if (previous_entry !== undefined && cursor.baseline_shard_key === previous_entry.shard_key) {
    return cursor.delta_link;
  }
  warnings.push(
    `The cursor for channel ${channel_id} does not match its latest shard; reading the channel in full`,
  );
  return undefined;
}
