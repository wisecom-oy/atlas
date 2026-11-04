import { is_invalid_delta_error } from '@wisecom/atlas-m365-graph';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  TeamsGraphResource,
  TeamsMessageDeltaResult,
  TeamsRootChange,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import { graph_status_of } from '@/services/shared/graph-error-status';

/** The roots one channel read returned and the delta link it leaves behind. */
export interface ChannelRootRead {
  readonly changes: TeamsRootChange[];
  /** Delta link from this read. Undefined for a channel without an email address. */
  readonly link: string | undefined;
  /** True when the read covered every root, so a previous root it does not list was removed. */
  readonly is_full: boolean;
}

/**
 * Reads the changed roots of a channel. Uses the stored delta link when the channel has an email
 * address (Graph's delta query requires one). Otherwise, or when Graph rejects the link, reads
 * every root in full.
 */
export async function read_channel_roots(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  prev_link: string | undefined,
): Promise<ChannelRootRead> {
  const has_email = typeof channel.email === 'string' && channel.email !== '';
  if (has_email && prev_link !== undefined) {
    try {
      const delta = await scope.connector.fetch_message_delta(
        scope.tenant_id,
        scope.team_id,
        channel.id,
        prev_link,
      );
      return { changes: delta.roots, link: delta.delta_link, is_full: false };
    } catch (err) {
      if (graph_status_of(err) !== 400 && !is_invalid_delta_error(err)) {
        throw err;
      }
      logger.warn(`Teams channel ${channel.id}: delta rejected, reading every root in full`);
    }
  }
  return read_full(scope, channel.id, has_email);
}

/**
 * Reads every root with the expanded messages list. A channel with an email address also takes a
 * delta read with no link, which supplies the link to store for the next run.
 */
async function read_full(
  scope: BackupRunScope,
  channel_id: string,
  has_email: boolean,
): Promise<ChannelRootRead> {
  const listed = await scope.connector.list_channel_messages(
    scope.tenant_id,
    scope.team_id,
    channel_id,
  );
  if (!has_email) {
    return { changes: listed, link: undefined, is_full: true };
  }
  const delta = await read_delta_without_link(scope, channel_id);
  if (delta === undefined) {
    return { changes: listed, link: undefined, is_full: true };
  }
  return {
    changes: merge_root_changes(listed, delta.roots),
    link: delta.delta_link,
    is_full: true,
  };
}

/**
 * Takes the link-less delta read that seeds the next run's link. Graph can reject it (400 or an
 * invalid delta), in which case the caller keeps the listed roots and stores no link.
 */
async function read_delta_without_link(
  scope: BackupRunScope,
  channel_id: string,
): Promise<TeamsMessageDeltaResult | undefined> {
  try {
    return await scope.connector.fetch_message_delta(
      scope.tenant_id,
      scope.team_id,
      channel_id,
      undefined,
    );
  } catch (err) {
    if (graph_status_of(err) !== 400 && !is_invalid_delta_error(err)) throw err;
    logger.warn(`Teams channel ${channel_id}: delta without a link rejected, no link stored`);
    return undefined;
  }
}

/** One change per root id. The delta read's version wins over the full read's. */
function merge_root_changes(
  listed: TeamsRootChange[],
  delta: TeamsRootChange[],
): TeamsRootChange[] {
  const by_id = new Map<string, TeamsRootChange>();
  for (const change of [...listed, ...delta]) {
    by_id.set(change.root.id, change);
  }
  return [...by_id.values()];
}
