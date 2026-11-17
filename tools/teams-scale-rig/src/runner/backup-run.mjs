/**
 * Runs one backup pass over the given teams through the real use case. Up to `parallel_teams`
 * teams run at once on this host, pulling from one shared list; each team uses the per-team
 * concurrency from the options. Teams are not ordered in time, so results are returned in input
 * order rather than completion order.
 */
import { TEAMS_BACKUP_USE_CASE_TOKEN } from '@wisecom/atlas-types';

/**
 * @param {{container: object, tenant_id: string, team_ids: string[], options?: object, parallel_teams?: number}} run
 * @returns {Promise<object[]>} one TeamsBackupResult per team, in input order
 */
export async function backup_teams({
  container,
  tenant_id,
  team_ids,
  options = {},
  parallel_teams = 1,
}) {
  const backup = container.get(TEAMS_BACKUP_USE_CASE_TOKEN);
  const results = new Array(team_ids.length);
  let next = 0;
  const pull_teams = async () => {
    while (next < team_ids.length) {
      const index = next++;
      results[index] = await backup.backup_team(tenant_id, team_ids[index], options);
    }
  };
  const workers = Math.min(Math.max(1, parallel_teams), team_ids.length);
  await Promise.all(Array.from({ length: workers }, pull_teams));
  return results;
}
