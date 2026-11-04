import { is_invalid_delta_error } from '@wisecom/atlas-m365-graph';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  TeamsChannelEntry,
  TeamsChannelReadMode,
  TeamsGraphResource,
  TeamsRootChange,
  TeamsThreadEntry,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { store_thread } from '@/services/backup/thread-store';
import { graph_status_of } from '@/services/shared/graph-error-status';

/** A channel that was backed up, with the delta link to store for it. */
export interface ChannelBackupOutput {
  readonly entry: TeamsChannelEntry;
  readonly next_link: string | undefined;
}

interface ChannelRead {
  readonly mode: TeamsChannelReadMode;
  readonly roots: TeamsRootChange[];
  readonly next_link: string | undefined;
}

/**
 * Backs up one channel. Returns undefined when the run was interrupted before every change was
 * applied, so the caller keeps the channel's previous entry and delta link.
 */
export async function backup_channel(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  previous: TeamsChannelEntry | undefined,
  prev_link: string | undefined,
): Promise<ChannelBackupOutput | undefined> {
  const { tenant_id, team_id } = scope;
  const members = await scope.connector.list_channel_members(tenant_id, team_id, channel.id);
  const tabs = await scope.connector.list_channel_tabs(tenant_id, team_id, channel.id);
  const files_folder = await scope.connector.get_channel_files_folder(
    tenant_id,
    team_id,
    channel.id,
  );
  const read = await read_channel_roots(scope, channel, prev_link);
  if (read.mode === 'full') {
    scope.counters.channels_full_read++;
  }
  const threads = await apply_root_changes(scope, channel.id, read, previous?.threads ?? {});
  if (threads === undefined) {
    return undefined;
  }
  const entry: TeamsChannelEntry = {
    id: channel.id,
    channel,
    members,
    tabs,
    files_folder,
    read_mode: read.mode,
    threads,
  };
  return { entry, next_link: read.next_link };
}

/**
 * Reads changed roots by delta when the channel has an email address, which Graph requires for
 * message delta. Falls back to a full read when Graph rejects the delta link or the channel has
 * no email.
 */
async function read_channel_roots(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  prev_link: string | undefined,
): Promise<ChannelRead> {
  if (typeof channel.email !== 'string' || channel.email === '') {
    return read_full(scope, channel.id);
  }
  try {
    const delta = await scope.connector.fetch_message_delta(
      scope.tenant_id,
      scope.team_id,
      channel.id,
      prev_link,
    );
    return { mode: 'delta', roots: delta.roots, next_link: delta.delta_link };
  } catch (err) {
    if (graph_status_of(err) !== 400 && !is_invalid_delta_error(err)) {
      throw err;
    }
    logger.warn(`Teams channel ${channel.id}: delta rejected, reading every root in full`);
    return read_full(scope, channel.id);
  }
}

async function read_full(scope: BackupRunScope, channel_id: string): Promise<ChannelRead> {
  const roots = await scope.connector.list_channel_messages(
    scope.tenant_id,
    scope.team_id,
    channel_id,
  );
  return { mode: 'full', roots, next_link: undefined };
}

/**
 * Applies the read to the previous thread map. A delta read only touches the roots it reports; a
 * full read is the whole channel, so a previous root it no longer lists is marked deleted.
 * ponytail: the full read is held in memory before storing; a page callback upgrades this for
 * very large channels.
 */
async function apply_root_changes(
  scope: BackupRunScope,
  channel_id: string,
  read: ChannelRead,
  previous_threads: Record<string, TeamsThreadEntry>,
): Promise<Record<string, TeamsThreadEntry> | undefined> {
  const threads: Record<string, TeamsThreadEntry> = { ...previous_threads };
  const seen = new Set<string>();
  for (const change of read.roots) {
    if (scope.should_interrupt()) {
      return undefined;
    }
    const root_id = change.root.id;
    seen.add(root_id);
    const previous = previous_threads[root_id];
    if (change.deleted) {
      if (previous !== undefined) {
        threads[root_id] = mark_deleted(scope, previous);
      }
      continue;
    }
    threads[root_id] = await store_thread(scope, channel_id, change.root, previous);
  }
  if (read.mode === 'full') {
    for (const [root_id, previous] of Object.entries(previous_threads)) {
      if (!seen.has(root_id)) {
        threads[root_id] = mark_deleted(scope, previous);
      }
    }
  }
  return threads;
}

function mark_deleted(scope: BackupRunScope, entry: TeamsThreadEntry): TeamsThreadEntry {
  if (entry.deleted_at !== undefined) {
    return entry;
  }
  scope.counters.threads_deleted++;
  return { ...entry, deleted_at: scope.backup_at };
}
