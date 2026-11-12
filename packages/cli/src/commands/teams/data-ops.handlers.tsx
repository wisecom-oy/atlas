import type { Container } from 'inversify';
import { Box } from 'ink';
import { logger } from '@wisecom/atlas-core';
import { report_unreadable_keys } from '@/command-unreadable-objects';
import type {
  TeamsDeletionUseCase,
  TeamsStatusUseCase,
  TeamsTeamStatus,
  TeamsVerificationUseCase,
} from '@wisecom/atlas-types';
import {
  TEAMS_DELETION_USE_CASE_TOKEN,
  TEAMS_STATUS_USE_CASE_TOKEN,
  TEAMS_VERIFICATION_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { ErrorList } from '@/ui/components/error-list';
import { KeyValueList } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';
import {
  confirm_deletion,
  print_delete_result,
  render_delete_banner,
} from '@/commands/shared/deletion-presenter';
import { resolve_tenant_id } from '@/commands/sharepoint/command.handlers';
import type { TeamsTenantOptions } from '@/commands/teams/command.handlers';

export interface TeamsVerifyOptions extends TeamsTenantOptions {
  team: string;
  snapshot: string;
}

export interface TeamsDeleteOptions extends TeamsTenantOptions {
  team: string;
  snapshot?: string;
  yes?: boolean;
}

interface StatusRow {
  team: string;
  last_backup: string;
  last_snapshot: string;
  channels: string;
  failed_roots: string;
  pending_rechecks: string;
}

const status_columns: TableColumn<StatusRow>[] = [
  { key: 'team', header: 'Team' },
  { key: 'last_backup', header: 'Last snapshot' },
  { key: 'last_snapshot', header: 'Snapshot' },
  { key: 'channels', header: 'Channels', align: 'right' },
  { key: 'failed_roots', header: 'Failed roots', align: 'right' },
  { key: 'pending_rechecks', header: 'Pending rechecks', align: 'right' },
];

/** Verifies every blob a Teams snapshot references and sets exit 1 on any failure. */
export async function execute_teams_verify(
  container: Container,
  options: TeamsVerifyOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const verifier = container.get<TeamsVerificationUseCase>(TEAMS_VERIFICATION_USE_CASE_TOKEN);
  const result = await verifier.verify_teams_snapshot(tenant_id, options.team, options.snapshot);

  await render_static_view(<Banner title={banner_title('teams', 'Verify')} />);
  const missing = result.missing_storage_keys.length;
  const failed = result.failed_storage_keys.length;
  const unsupported = result.unsupported_storage_keys.length;
  if (missing === 0 && failed === 0 && unsupported === 0) {
    logger.success(`All ${result.total_checked} entries passed verification`);
    return;
  }

  logger.error(`Failures: missing=${missing}, blobs=${failed}, unsupported=${unsupported}`);
  const failures = [
    ...result.missing_storage_keys.map((key) => `missing: ${key}`),
    ...result.failed_storage_keys.map((key) => `blob mismatch: ${key}`),
    ...result.unsupported_storage_keys.map((key) => `unsupported format: ${key}`),
  ];
  await render_static_view(<ErrorList errors={failures} max={failures.length} />);
  process.exitCode = 1;
}

/** Reports the last snapshot recorded for each team in the tenant. */
export async function execute_teams_status(
  container: Container,
  options: TeamsTenantOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);

  await render_static_view(
    <Box flexDirection="column">
      <Banner title={banner_title('teams', 'Status')} />
      <KeyValueList items={[{ label: 'Tenant', value: tenant_id }]} />
    </Box>,
  );

  const status = container.get<TeamsStatusUseCase>(TEAMS_STATUS_USE_CASE_TOKEN);
  const teams = await status.check_teams_status(tenant_id);
  if (teams.length === 0) {
    logger.info('No teams found.');
    return;
  }

  const rows: StatusRow[] = teams.map((team) => ({
    team: team.team_display_name ?? team.team_id,
    last_backup: team.last_backup_at?.toISOString() ?? 'never',
    last_snapshot: team.last_snapshot_id ?? '-',
    channels: String(team.total_channels),
    failed_roots: String(team.failed_root_count),
    pending_rechecks: String(team.pending_recheck_count),
  }));
  await render_static_view(<DataTable columns={status_columns} rows={rows} />);
  for (const team of teams) warn_team_status(team);
  report_unreadable_keys(teams.flatMap((team) => team.unreadable_keys));
}

/**
 * Warns about one team's damaged cursors, newer-format objects, and failed roots, which the table
 * omits. Damaged indexes are reported for the whole tenant afterwards, with exit 9.
 */
function warn_team_status(team: TeamsTeamStatus): void {
  const name = team.team_display_name ?? team.team_id;
  if (team.unreadable_cursor_keys.length > 0) {
    logger.warn(
      `${name}: ${team.unreadable_cursor_keys.length} channel cursor(s) could not be read; ` +
        `the next backup reads those channels in full: ${team.unreadable_cursor_keys.join(', ')}`,
    );
  }
  if (team.unsupported_keys.length > 0) {
    logger.warn(
      `${name}: ${team.unsupported_keys.length} Teams object(s) use a newer format and were skipped: ${team.unsupported_keys.join(', ')}`,
    );
  }
  if (team.failed_root_count > 0) {
    logger.warn(`${name}: ${team.failed_root_count} channel root(s) failed in a previous run`);
  }
}

/** Deletes one Teams snapshot, or every backup for a team, after confirmation. */
export async function execute_teams_delete(
  container: Container,
  options: TeamsDeleteOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  await render_delete_banner();

  const description = options.snapshot
    ? `This will delete Teams snapshot ${options.snapshot} for ${options.team}. ` +
      'Only its manifest is removed. Stored message data is kept until a team data ' +
      'delete removes it, even when no other snapshot references it.'
    : `This will delete all Teams data and manifests for ${options.team}`;

  if (!(await confirm_deletion(description, options.yes))) return;

  const deletion = container.get<TeamsDeletionUseCase>(TEAMS_DELETION_USE_CASE_TOKEN);
  const result = options.snapshot
    ? await deletion.delete_snapshot(tenant_id, options.team, options.snapshot)
    : await deletion.delete_team_data(tenant_id, options.team);
  print_delete_result(result);
}
