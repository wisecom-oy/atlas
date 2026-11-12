import { retryable_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import {
  TEAMS_FORMAT_VERSION,
  type FailedItemLedger,
  type TeamsChannelCheckpointHead,
  type TeamsChannelIndexEntry,
  type TeamsChannelShard,
  type TeamsFilesFolderRef,
  type TeamsGraphResource,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { read_channel_pages } from '@/services/backup/channel-root-reader';
import { open_channel_run, type ChannelRunStart } from '@/services/backup/channel-run-state';
import { channel_hosted_journal } from '@/services/backup/hosted-journal';
import type { HostedRecheck } from '@/services/backup/hosted-recheck';
import { shard_fingerprint } from '@/services/backup/shard-fingerprint';
import { error_message } from '@/services/shared/error-message';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

/** What a channel starts from: its previous index entry and shard, and its stored cursor state. */
export interface ChannelStartState {
  readonly previous_entry: TeamsChannelIndexEntry | undefined;
  readonly previous_shard: TeamsChannelShard | undefined;
  /** The cursor's delta link, already trusted only when the cursor matches the previous shard. */
  readonly stored_link: string | undefined;
  readonly failed_roots: FailedItemLedger;
  readonly hosted_recheck: HostedRecheck;
  /** The previous shard's key when it could not be read and this run rebuilds the channel. */
  readonly unreadable_shard_key?: string | undefined;
}

/** What one channel backup produced. */
export interface ChannelBackupOutput {
  /** The channel's new shard. Saved by the persister unless `reused_entry` is set. */
  readonly shard: TeamsChannelShard;
  /** The previous index entry, when the new shard's content equals the previous shard's. */
  readonly reused_entry: TeamsChannelIndexEntry | undefined;
  /** Fresh link when the channel completed, otherwise the stored link so the next run re-reads. */
  readonly next_link: string | undefined;
  readonly interrupted: boolean;
  /** True when a valid checkpoint was loaded and this run continued it. */
  readonly resumed_from_checkpoint: boolean;
  /** The checkpoint head as last saved by this run. Undefined when none is in storage. */
  readonly checkpoint: TeamsChannelCheckpointHead | undefined;
  readonly failed_roots: FailedItemLedger;
  readonly hosted_recheck: HostedRecheck;
  readonly errors: string[];
  readonly warnings: string[];
  /** Carried from the start state, so the new shard replaces a damaged object at the same key. */
  readonly unreadable_shard_key?: string | undefined;
}

/** The Files folder fields of a channel shard, as resolved for this run. */
interface FilesFolderState {
  readonly files_folder: TeamsFilesFolderRef | undefined;
  readonly files_folder_unavailable: true | undefined;
}

/**
 * Backs up one channel: its metadata, then its root changes, into a new shard. `--full` reads every
 * root instead of following the stored link. A channel with a failed root or an interruption keeps
 * the stored link, so the next run presents those roots again.
 */
export async function backup_channel(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  start: ChannelStartState,
): Promise<ChannelBackupOutput> {
  const { tenant_id, team_id } = scope;
  const warnings: string[] = [];
  // A standard channel's members are the team's members; listing them again repeats the team list.
  const standard = channel.membershipType === 'standard';
  const members = standard
    ? []
    : await scope.connector.list_channel_members(tenant_id, team_id, channel.id);
  const tabs = await scope.connector.list_channel_tabs(tenant_id, team_id, channel.id);
  const folder = await resolve_files_folder(scope, channel.id, start.previous_shard, warnings);
  const shared_with_teams = await resolve_shared_teams(
    scope,
    channel,
    start.previous_shard,
    warnings,
  );
  const has_email = typeof channel.email === 'string' && channel.email !== '';
  const mode = scope.force_full || start.stored_link === undefined || !has_email ? 'full' : 'delta';
  const run = await open_channel_run(
    scope,
    channel.id,
    {
      baseline_shard_key: start.previous_entry?.shard_key,
      stored_link: start.stored_link,
      threads: start.previous_shard?.threads ?? {},
      failed_roots: start.failed_roots,
      hosted_recheck: start.hosted_recheck,
    } satisfies ChannelRunStart,
    mode,
    has_email,
  );
  const interrupted = await read_channel_pages(
    { ...scope, hosted_journal: channel_hosted_journal(scope, run) },
    channel,
    run,
  );
  if (run.mode === 'full') scope.counters.channels_full_read++;
  append_all(warnings, run.state.warnings);
  const complete = !interrupted && retryable_items(run.state.failed_roots, channel.id).length === 0;
  const shard: TeamsChannelShard = {
    format_version: TEAMS_FORMAT_VERSION,
    team_id,
    channel_id: channel.id,
    channel,
    members,
    members_from_team: standard || undefined,
    tabs,
    files_folder: folder.files_folder,
    files_folder_unavailable: folder.files_folder_unavailable,
    shared_with_teams,
    read_mode: run.mode,
    threads: run.state.threads,
  };
  return {
    shard,
    reused_entry: reused_entry(shard, start),
    next_link: complete ? run.pending_delta_link : start.stored_link,
    interrupted,
    resumed_from_checkpoint: run.resumed,
    checkpoint: run.head,
    failed_roots: run.state.failed_roots,
    hosted_recheck: run.state.hosted_recheck,
    errors: run.state.errors,
    warnings,
    unreadable_shard_key: start.unreadable_shard_key,
  };
}

/**
 * Returns the previous entry, with its deletion marker cleared, when the new shard holds the same
 * content as the previous shard. Such a channel needs no new shard and no new index entry.
 */
function reused_entry(
  shard: TeamsChannelShard,
  start: ChannelStartState,
): TeamsChannelIndexEntry | undefined {
  if (start.previous_entry === undefined || start.previous_shard === undefined) {
    return undefined;
  }
  if (shard_fingerprint(shard) !== shard_fingerprint(start.previous_shard)) {
    return undefined;
  }
  return { ...start.previous_entry, deleted_at: undefined };
}

/**
 * Reuses the stored files folder, or the stored unavailable marker, unless `--full`. A 403 sets the
 * marker so the lookup is not repeated every run. A lookup error keeps the previous state.
 */
async function resolve_files_folder(
  scope: BackupRunScope,
  channel_id: string,
  previous: TeamsChannelShard | undefined,
  warnings: string[],
): Promise<FilesFolderState> {
  if (!scope.force_full && previous?.files_folder !== undefined) {
    return { files_folder: previous.files_folder, files_folder_unavailable: undefined };
  }
  if (!scope.force_full && previous?.files_folder_unavailable === true) {
    return { files_folder: undefined, files_folder_unavailable: true };
  }
  try {
    const found = await scope.connector.get_channel_files_folder(
      scope.tenant_id,
      scope.team_id,
      channel_id,
    );
    if (found === 'unavailable') {
      warnings.push(
        `Channel ${channel_id}: files folder not accessible (403); not retried until a --full run`,
      );
      return { files_folder: undefined, files_folder_unavailable: true };
    }
    return { files_folder: found, files_folder_unavailable: undefined };
  } catch (err) {
    warnings.push(
      `Channel ${channel_id}: files folder not resolved (${error_message(err)}); kept the previous value`,
    );
    return {
      files_folder: previous?.files_folder,
      files_folder_unavailable: previous?.files_folder_unavailable,
    };
  }
}

/** Lists the teams a shared channel is shared with. A lookup failure keeps the previous value. */
async function resolve_shared_teams(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  previous: TeamsChannelShard | undefined,
  warnings: string[],
): Promise<TeamsGraphResource[] | undefined> {
  if (channel.membershipType !== 'shared') {
    return undefined;
  }
  try {
    return await scope.connector.list_channel_shared_teams(
      scope.tenant_id,
      scope.team_id,
      channel.id,
    );
  } catch (err) {
    warnings.push(
      `Channel ${channel.id}: shared teams not resolved (${error_message(err)}); kept the previous value`,
    );
    return previous?.shared_with_teams;
  }
}
