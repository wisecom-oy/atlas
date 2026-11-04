import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  FailedItemLedger,
  TeamsBackupOptions,
  TeamsChannelEntry,
  TeamsGraphResource,
} from '@wisecom/atlas-types';
import { AuthError } from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { backup_channel } from '@/services/backup/channel-backup-processor';
import { error_message } from '@/services/shared/error-message';

/** What the channel loop produced: entries and links for channels it finished, plus run flags. */
export interface ChannelRunState {
  readonly entries: Map<string, TeamsChannelEntry>;
  readonly links: Record<string, string>;
  ledger: FailedItemLedger;
  readonly errors: string[];
  readonly warnings: string[];
  attempted: number;
  interrupted: boolean;
}

/** Read-only inputs for one channel step: the previous snapshot, stored links, and run options. */
export interface ChannelRunInputs {
  readonly previous_channels: TeamsChannelEntry[] | undefined;
  readonly stored_links: Record<string, string>;
  readonly options: TeamsBackupOptions;
}

/**
 * Processes the selected channels in order. Stops at the first interruption. A channel that fails
 * is recorded and skipped, so the others still run. An authentication failure on the first channel
 * is rethrown, because it means the whole run cannot authenticate.
 */
export async function process_channels(
  scope: BackupRunScope,
  channels: TeamsGraphResource[],
  inputs: ChannelRunInputs,
  initial_ledger: FailedItemLedger,
): Promise<ChannelRunState> {
  const state: ChannelRunState = {
    entries: new Map(),
    links: { ...inputs.stored_links },
    ledger: initial_ledger,
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
  const previous_entry = inputs.previous_channels?.find((c) => c.id === channel.id);
  try {
    const output = await backup_channel(
      scope,
      channel,
      previous_entry,
      inputs.stored_links[channel.id],
      state.ledger,
    );
    state.entries.set(channel.id, output.entry);
    state.ledger = output.failed_roots;
    state.errors.push(...output.errors);
    state.warnings.push(...output.warnings);
    if (output.next_link === undefined) {
      delete state.links[channel.id];
    } else {
      state.links[channel.id] = output.next_link;
    }
    return !output.interrupted;
  } catch (err) {
    if (err instanceof AuthError && state.attempted === 1) {
      throw err;
    }
    const message = error_message(err);
    logger.warn(`Teams channel ${channel.id} backup failed: ${message}`);
    state.errors.push(`Channel ${channel.id}: ${message}`);
    return true;
  }
}
