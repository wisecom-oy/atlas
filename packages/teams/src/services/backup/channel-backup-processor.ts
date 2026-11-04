import { retryable_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import type { FailedItemLedger, TeamsChannelEntry, TeamsGraphResource } from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { apply_root_changes } from '@/services/backup/channel-root-applier';
import { read_channel_roots } from '@/services/backup/channel-root-reader';
import { error_message } from '@/services/shared/error-message';

/** What one channel backup produced: its entry, the delta link to store, and what went wrong. */
export interface ChannelBackupOutput {
  readonly entry: TeamsChannelEntry;
  /** Fresh link when the channel completed, otherwise the previous link so the next run re-reads. */
  readonly next_link: string | undefined;
  readonly complete: boolean;
  readonly interrupted: boolean;
  readonly failed_roots: FailedItemLedger;
  readonly errors: string[];
  readonly warnings: string[];
}

/**
 * Backs up one channel: its metadata, then its root changes. A channel with a failed root or an
 * interruption keeps its previous delta link, so the next run presents those roots again.
 */
export async function backup_channel(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  previous: TeamsChannelEntry | undefined,
  prev_link: string | undefined,
  ledger: FailedItemLedger,
): Promise<ChannelBackupOutput> {
  const { tenant_id, team_id } = scope;
  const warnings: string[] = [];
  const members = await scope.connector.list_channel_members(tenant_id, team_id, channel.id);
  const tabs = await scope.connector.list_channel_tabs(tenant_id, team_id, channel.id);
  const files_folder = await resolve_files_folder(scope, channel.id, previous, warnings);
  const shared_with_teams = await resolve_shared_teams(scope, channel, previous, warnings);
  const read = await read_channel_roots(scope, channel, prev_link);
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
    tabs,
    files_folder,
    shared_with_teams,
    read_mode: read.is_full ? 'full' : 'delta',
    threads: applied.threads,
  };
  return {
    entry,
    next_link: complete ? read.link : prev_link,
    complete,
    interrupted: applied.interrupted,
    failed_roots: applied.failed_roots,
    errors: applied.errors,
    warnings,
  };
}

/** Reuses the stored files folder unless `--full`. A lookup failure keeps the previous value. */
async function resolve_files_folder(
  scope: BackupRunScope,
  channel_id: string,
  previous: TeamsChannelEntry | undefined,
  warnings: string[],
): Promise<TeamsChannelEntry['files_folder']> {
  if (!scope.force_full && previous?.files_folder !== undefined) {
    return previous.files_folder;
  }
  try {
    return await scope.connector.get_channel_files_folder(
      scope.tenant_id,
      scope.team_id,
      channel_id,
    );
  } catch (err) {
    warnings.push(
      `Channel ${channel_id}: files folder not resolved (${error_message(err)}); kept the previous value`,
    );
    return previous?.files_folder;
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
