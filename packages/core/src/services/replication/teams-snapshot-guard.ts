import { ConfigError } from '@wisecom/atlas-types';

/**
 * Refuses Teams snapshot ids (`teams-snap-*`) until Teams has a replication path. Without this
 * they fall through to the Outlook manifest lookup and fail with NotFound.
 */
export function reject_teams_snapshot(snapshot_id: string): void {
  if (snapshot_id.startsWith('teams-snap-')) {
    throw new ConfigError('Teams snapshots are not replicated yet');
  }
}
