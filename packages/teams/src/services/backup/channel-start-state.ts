import {
  UnreadableContentError,
  type FailedItemLedger,
  type TeamsChannelShardRepository,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import type { ChannelStartState } from '@/services/backup/channel-backup-processor';
import type { HostedRecheck } from '@/services/backup/hosted-recheck';
import type { TeamsBaseline } from '@/services/backup/team-baseline-loader';

/** A channel's start state, plus the warnings that loading it raised. */
export interface LoadedChannelStart {
  readonly start: ChannelStartState;
  readonly warnings: string[];
}

/** Cursor state a channel keeps whether or not its previous shard can be read. */
interface CursorCarryover {
  readonly failed_roots: FailedItemLedger;
  readonly hosted_recheck: HostedRecheck;
}

/**
 * Loads what a channel starts from: its baseline and its previous shard. A previous shard that is
 * missing, damaged, or misnamed fails the channel with an error naming the recovery command, unless
 * the run is `--full`, which rebuilds the channel from Graph instead (issue #708). Any other load
 * failure, such as a storage outage or a newer-format shard, propagates unchanged, so it is never
 * mistaken for damage.
 */
export async function load_channel_start_state(
  scope: BackupRunScope,
  channel_id: string,
  baseline: TeamsBaseline,
  shards: TeamsChannelShardRepository,
): Promise<LoadedChannelStart> {
  const base = baseline.channels.get(channel_id);
  const previous_entry = base?.previous_entry;
  const carryover: CursorCarryover = {
    failed_roots: base?.failed_roots ?? {},
    hosted_recheck: base?.hosted_recheck ?? {},
  };
  if (previous_entry === undefined) {
    return {
      start: {
        previous_entry,
        previous_shard: undefined,
        stored_link: base?.delta_link,
        ...carryover,
      },
      warnings: [],
    };
  }
  try {
    const previous_shard = await shards.load(scope.ctx, previous_entry.shard_key);
    return {
      start: { previous_entry, previous_shard, stored_link: base?.delta_link, ...carryover },
      warnings: [],
    };
  } catch (err) {
    if (!(err instanceof UnreadableContentError)) throw err;
    if (!scope.force_full) throw unreadable_shard_error(scope.team_id, channel_id, err);
    return {
      start: rebuild_start(previous_entry.shard_key, carryover),
      warnings: [rebuild_warning(channel_id, err)],
    };
  }
}

/**
 * The start of a rebuild: an empty thread set read in full, as for a new channel. The previous
 * entry and stored link are dropped because both describe the shard that can no longer be read. A
 * checkpoint bound to that shard therefore no longer matches and is discarded, rather than replayed
 * onto threads this run does not have.
 */
function rebuild_start(
  unreadable_shard_key: string,
  carryover: CursorCarryover,
): ChannelStartState {
  return {
    previous_entry: undefined,
    previous_shard: undefined,
    stored_link: undefined,
    unreadable_shard_key,
    ...carryover,
  };
}

/** The shard error with the command that rebuilds the channel appended. */
function unreadable_shard_error(
  team_id: string,
  channel_id: string,
  err: UnreadableContentError,
): UnreadableContentError {
  return new UnreadableContentError(
    `${err.message}. Run \`atlas teams backup --team ${team_id} --channel ${channel_id} --full\` ` +
      'to rebuild the channel from Microsoft Graph',
    { cause: err },
  );
}

/** Warning for a channel whose previous shard is unreadable and which `--full` rebuilds. */
function rebuild_warning(channel_id: string, err: UnreadableContentError): string {
  return `Channel ${channel_id}: ${err.message}; rebuilding the channel from Microsoft Graph (--full)`;
}
