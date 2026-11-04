import type { Command } from 'commander';
import type { Container } from 'inversify';
import {
  execute_teams_backup,
  execute_teams_list_snapshots,
  execute_teams_list_teams,
  type TeamsBackupCommandOptions,
  type TeamsListSnapshotsOptions,
  type TeamsTenantOptions,
} from '@/commands/teams-command.handlers';
import {
  execute_teams_delete,
  execute_teams_status,
  execute_teams_verify,
  type TeamsDeleteOptions,
  type TeamsVerifyOptions,
} from '@/commands/teams-data-ops.handlers';
import { execute_teams_save, type TeamsSaveCommandOptions } from '@/commands/teams-save.handlers';
import {
  with_object_lock,
  with_output,
  with_required_snapshot,
  with_snapshot,
  with_tenant,
  with_yes,
} from '@/commands/shared-options';

type ContainerFactory = () => Container;

// `--team` carries no short flag: `-t` is the tenant on every command, and `-s` is the snapshot.
const TEAM_FLAG = '--team <id>';
const TEAM_DESCRIPTION = 'Teams team ID';

/** Collects a repeatable `--team` flag into an array. */
function collect_team(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Registers `atlas teams` command group. */
export function register_teams_command(program: Command, get_container: ContainerFactory): void {
  const group = program
    .command('teams')
    .description('Teams channel backup, verify, catalog, status, and deletion commands');
  register_teams_list_teams(group, get_container);
  register_teams_backup(group, get_container);
  register_teams_list_snapshots(group, get_container);
  register_teams_verify(group, get_container);
  register_teams_save(group, get_container);
  register_teams_status(group, get_container);
  register_teams_delete(group, get_container);
}

function register_teams_list_teams(group: Command, get_container: ContainerFactory): void {
  const command = group.command('list-teams').description('List teams in the tenant');
  with_tenant(command).action((options: TeamsTenantOptions) =>
    execute_teams_list_teams(get_container(), options),
  );
}

function register_teams_backup(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('backup')
    .description('Back up channel messages for one or more teams')
    .option('--team <id>', 'team ID to back up (repeatable)', collect_team)
    .option('--all', 'back up every team in the tenant')
    .option('--channel <id>', 'back up only this channel; other channels carry forward')
    .option('--full', 'force full crawl ignoring saved delta state')
    .option('--concurrency <n>', 'channels backed up at once, 1 to 16 (default 4)');
  with_object_lock(command, 'lock every object this run writes for N days');
  with_tenant(command).action((options: TeamsBackupCommandOptions) =>
    execute_teams_backup(get_container(), options),
  );
}

function register_teams_list_snapshots(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('list-snapshots')
    .description('List backed-up snapshots for one team')
    .requiredOption(TEAM_FLAG, TEAM_DESCRIPTION);
  with_tenant(command).action((options: TeamsListSnapshotsOptions) =>
    execute_teams_list_snapshots(get_container(), options),
  );
}

function register_teams_verify(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('verify')
    .description('Verify integrity of a Teams snapshot')
    .requiredOption(TEAM_FLAG, TEAM_DESCRIPTION);
  with_required_snapshot(command, 'snapshot identifier');
  with_tenant(command).action((options: TeamsVerifyOptions) =>
    execute_teams_verify(get_container(), options),
  );
}

function register_teams_save(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('save')
    .description('Save a Teams snapshot, or one channel of it, as a zip archive')
    .requiredOption(TEAM_FLAG, TEAM_DESCRIPTION)
    .option('--channel <id>', 'save only this channel');
  with_required_snapshot(command, 'snapshot identifier');
  with_output(command, 'output zip file path');
  with_tenant(command).action((options: TeamsSaveCommandOptions) =>
    execute_teams_save(get_container(), options),
  );
}

function register_teams_status(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('status')
    .description('Show the last Teams snapshot recorded for each team');
  with_tenant(command).action((options: TeamsTenantOptions) =>
    execute_teams_status(get_container(), options),
  );
}

function register_teams_delete(group: Command, get_container: ContainerFactory): void {
  const command = group
    .command('delete')
    .description('Delete Teams backups for one team, or a single snapshot')
    .requiredOption(TEAM_FLAG, TEAM_DESCRIPTION);
  with_snapshot(command, 'delete a single snapshot instead of every backup');
  with_yes(command);
  with_tenant(command).action((options: TeamsDeleteOptions) =>
    execute_teams_delete(get_container(), options),
  );
}
