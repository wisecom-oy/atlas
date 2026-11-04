import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  AuthError,
  UnsupportedFormatVersionError,
  type TeamsBackupOptions,
  type TeamsChannelShardRepository,
  type TeamsGraphResource,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  backup_channel,
  type ChannelBackupOutput,
  type ChannelStartState,
} from '@/services/backup/channel-backup-processor';
import type { TeamsBaseline } from '@/services/backup/team-baseline-loader';
import { error_message } from '@/services/shared/error-message';

/** What the channel loop produced: outputs for channels it attempted, plus run flags. */
export interface ChannelRunState {
  readonly results: Map<string, ChannelBackupOutput>;
  readonly errors: string[];
  readonly warnings: string[];
  attempted: number;
  interrupted: boolean;
}

/** Read-only inputs for the channel loop: the loaded baseline, the shard store, and run options. */
export interface ChannelRunInputs {
  readonly baseline: TeamsBaseline;
  readonly shards: TeamsChannelShardRepository;
  readonly options: TeamsBackupOptions;
}

/**
 * Processes the selected channels in order. Stops at the first interruption. A channel that fails
 * is recorded and skipped, so the others still run. An authentication failure or a shard written
 * by a newer format is rethrown from any channel, since the remaining channels would fail the same
 * way.
 */
export async function process_channels(
  scope: BackupRunScope,
  channels: TeamsGraphResource[],
  inputs: ChannelRunInputs,
): Promise<ChannelRunState> {
  const state: ChannelRunState = {
    results: new Map(),
    errors: [],
    warnings: [],
    attempted: 0,
    interrupted: false,
  };
  for (const channel of channels) {
    if (inputs.options.channel_id !== undefined && channel.id !== inputs.options.channel_id) {
      continue;
    }
    if (scope.should_interrupt()) {
      state.interrupted = true;
      break;
    }
    state.attempted++;
    const continues = await run_channel(scope, channel, state, inputs);
    if (!continues) {
      state.interrupted = true;
      break;
    }
  }
  return state;
}

/** Backs up one channel into `state`. Returns false when the run was interrupted during it. */
async function run_channel(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  state: ChannelRunState,
  inputs: ChannelRunInputs,
): Promise<boolean> {
  try {
    const start = await channel_start_state(scope, channel.id, inputs);
    const output = await backup_channel(scope, channel, start);
    state.results.set(channel.id, output);
    state.errors.push(...output.errors);
    state.warnings.push(...output.warnings);
    return !output.interrupted;
  } catch (err) {
    if (err instanceof AuthError || err instanceof UnsupportedFormatVersionError) {
      throw err;
    }
    const message = error_message(err);
    logger.warn(`Teams channel ${channel.id} backup failed: ${message}`);
    state.errors.push(`Channel ${channel.id}: ${message}`);
    return true;
  }
}

/** Loads the channel's previous shard, so unchanged content and the cursor can be compared. */
async function channel_start_state(
  scope: BackupRunScope,
  channel_id: string,
  inputs: ChannelRunInputs,
): Promise<ChannelStartState> {
  const base = inputs.baseline.channels.get(channel_id);
  const previous_entry = base?.previous_entry;
  return {
    previous_entry,
    previous_shard:
      previous_entry === undefined
        ? undefined
        : await inputs.shards.load(scope.ctx, previous_entry.shard_key),
    stored_link: base?.delta_link,
    failed_roots: base?.failed_roots ?? {},
  };
}
