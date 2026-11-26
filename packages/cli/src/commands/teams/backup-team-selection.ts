import type { Container } from 'inversify';
import type { TeamsCatalogUseCase } from '@wisecom/atlas-types';
import { TEAMS_CATALOG_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import type { InterruptGate } from '@/adapters/interrupt-gate';
import { resolve_under_gate } from '@/adapters/gated-resolution';
import type { TeamsBackupCommandOptions } from '@/commands/teams/command.handlers';

/**
 * Resolves the teams to back up under the command's interrupt gate. Undefined when the first
 * Ctrl+C stopped the lookup, so the command reports an interrupted run without starting a team.
 */
export async function resolve_team_ids_under_gate(
  container: Container,
  tenant_id: string,
  options: TeamsBackupCommandOptions,
  gate: InterruptGate,
): Promise<string[] | undefined> {
  try {
    return await resolve_under_gate(gate, () =>
      resolve_backup_team_ids(container, tenant_id, options),
    );
  } catch (err) {
    if (!gate.abort_signal.aborted) throw err;
    return undefined;
  }
}

/** Resolves the `--team` ids, or every team in the tenant with `--all`. */
async function resolve_backup_team_ids(
  container: Container,
  tenant_id: string,
  options: TeamsBackupCommandOptions,
): Promise<string[]> {
  if (options.all && options.team?.length) {
    throw new Error('Use either --team or --all, not both');
  }
  if (options.all) {
    const catalog = container.get<TeamsCatalogUseCase>(TEAMS_CATALOG_USE_CASE_TOKEN);
    const teams = await catalog.list_teams(tenant_id);
    return teams.map((team) => team.id);
  }
  if (options.team?.length) return options.team;
  throw new Error('Pass --team <id> (repeatable) or --all');
}

/** `--channel` names one channel inside one team, so it is rejected for `--all` or several `--team` values. */
export function assert_channel_scope(options: TeamsBackupCommandOptions): void {
  if (options.channel === undefined) return;
  if (options.all || options.team?.length !== 1) {
    throw new Error('--channel requires exactly one --team');
  }
}
