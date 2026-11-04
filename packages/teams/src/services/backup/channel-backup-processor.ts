import { retryable_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger, TeamsChannelEntry, TeamsGraphResource } from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { apply_root_changes } from '@/services/backup/channel-root-applier';
import { read_channel_roots } from '@/services/backup/channel-root-reader';
import { error_message } from '@/services/shared/error-message';

/** What one channel backup produced: its entry, the delta link to store, and what went wrong. */
export interface ChannelBackupOutput {
  readonly entry: TeamsChannelEntry;
  /** Fresh link when the channel completed, otherwise the stored link so the next run re-reads. */
  readonly next_link: string | undefined;
  readonly complete: boolean;
  readonly interrupted: boolean;
  readonly failed_roots: FailedItemLedger;
  readonly errors: string[];
  readonly warnings: string[];
}

/** The Files folder fields of a channel entry, as resolved for this run. */
interface FilesFolderState {
  readonly files_folder: TeamsChannelEntry['files_folder'];
  readonly files_folder_unavailable: true | undefined;
}

/**
 * Backs up one channel: its metadata, then its root changes. `stored_link` is the delta link from
 * the previous run. `--full` reads every root instead of following it. A channel with a failed root
 * or an interruption keeps the stored link, so the next run presents those roots again.
 */
export async function backup_channel(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  previous: TeamsChannelEntry | undefined,
  stored_link: string | undefined,
  ledger: FailedItemLedger,
): Promise<ChannelBackupOutput> {
  const { tenant_id, team_id } = scope;
  const warnings: string[] = [];
  // A standard channel's members are the team's members; listing them again repeats the team list.
  const standard = channel.membershipType === 'standard';
  const members = standard
    ? []
    : await scope.connector.list_channel_members(tenant_id, team_id, channel.id);
  const tabs = await scope.connector.list_channel_tabs(tenant_id, team_id, channel.id);
  const folder = await resolve_files_folder(scope, channel.id, previous, warnings);
  const shared_with_teams = await resolve_shared_teams(scope, channel, previous, warnings);
  const read = await read_channel_roots(scope, channel, scope.force_full ? undefined : stored_link);
  if (read.is_full) scope.counters.channels_full_read++;
  const applied = await apply_root_changes(
    scope,
    channel.id,
    read,
    previous?.threads ?? {},
    ledger,
  );
  const complete =
    !applied.interrupted && retryable_items(applied.failed_roots, channel.id).length === 0;
  const entry: TeamsChannelEntry = {
    id: channel.id,
    channel,
    members,
    members_from_team: standard || undefined,
    tabs,
    files_folder: folder.files_folder,
    files_folder_unavailable: folder.files_folder_unavailable,
    shared_with_teams,
    read_mode: read.is_full ? 'full' : 'delta',
    threads: applied.threads,
  };
  return {
    entry,
    next_link: complete ? read.link : stored_link,
    complete,
    interrupted: applied.interrupted,
    failed_roots: applied.failed_roots,
    errors: applied.errors,
    warnings,
  };
}

/**
 * Reuses the stored files folder, or the stored unavailable marker, unless `--full`. A 403 sets the
 * marker so the lookup is not repeated every run. A lookup error keeps the previous state.
 */
async function resolve_files_folder(
  scope: BackupRunScope,
  channel_id: string,
  previous: TeamsChannelEntry | undefined,
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
  previous: TeamsChannelEntry | undefined,
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
