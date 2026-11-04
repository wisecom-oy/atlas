import type { Container } from 'inversify';
import { Box } from 'ink';
import { logger } from '@wisecom/atlas-core';
import type {
  TeamsBackupResult,
  TeamsBackupUseCase,
  TeamsCatalogUseCase,
} from '@wisecom/atlas-types';
import { TEAMS_BACKUP_USE_CASE_TOKEN, TEAMS_CATALOG_USE_CASE_TOKEN } from '@wisecom/atlas-types';
import { build_object_lock_request } from '@/command-object-lock';
import { report_run_outcome } from '@/command-run-outcome';
import { install_interrupt_gate } from '@/adapters/interrupt-gate';
import { resolve_tenant_id } from '@/commands/sharepoint-command.handlers';
import { banner_title } from '@/ui/banner-title';
import { Banner } from '@/ui/components/banner';
import { DataTable, type TableColumn } from '@/ui/components/data-table';
import { KeyValueList } from '@/ui/components/key-value-list';
import { ResultSummary, type SummaryEntry } from '@/ui/components/result-summary';
import { render_static_view } from '@/ui/render';

export interface TeamsTenantOptions {
  tenant?: string;
}

export interface TeamsBackupCommandOptions extends TeamsTenantOptions {
  team?: string[];
  all?: boolean;
  channel?: string;
  full?: boolean;
  retentionDays?: string;
  lockMode?: string;
}

export interface TeamsListSnapshotsOptions extends TeamsTenantOptions {
  team: string;
}

interface TeamRow {
  team_id: string;
  display_name: string;
}

const team_columns: TableColumn<TeamRow>[] = [
  { key: 'team_id', header: 'Team ID' },
  { key: 'display_name', header: 'Name' },
];

interface SnapshotRow {
  snapshot_id: string;
  created_at: string;
  channels: string;
  threads: string;
  size_bytes: string;
}

const snapshot_columns: TableColumn<SnapshotRow>[] = [
  { key: 'snapshot_id', header: 'Snapshot ID' },
  { key: 'created_at', header: 'Created' },
  { key: 'channels', header: 'Channels', align: 'right' },
  { key: 'threads', header: 'Threads', align: 'right' },
  { key: 'size_bytes', header: 'Bytes', align: 'right' },
];

/** Lists every team the tenant exposes through Graph. */
export async function execute_teams_list_teams(
  container: Container,
  options: TeamsTenantOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const catalog = container.get<TeamsCatalogUseCase>(TEAMS_CATALOG_USE_CASE_TOKEN);
  const teams = await catalog.list_teams(tenant_id);

  await render_static_view(<Banner title={banner_title('teams', 'List')} />);
  if (teams.length === 0) {
    logger.info('No teams found.');
    return;
  }

  const rows: TeamRow[] = teams.map((team) => ({
    team_id: team.id,
    display_name: team.displayName ?? '',
  }));
  await render_static_view(<DataTable columns={team_columns} rows={rows} />);
  logger.info(`\n${teams.length} team(s) found.`);
}

/** Lists the backed-up snapshots for one team, newest data first as the catalog returns them. */
export async function execute_teams_list_snapshots(
  container: Container,
  options: TeamsListSnapshotsOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  const catalog = container.get<TeamsCatalogUseCase>(TEAMS_CATALOG_USE_CASE_TOKEN);
  const snapshots = await catalog.list_teams_snapshots(tenant_id, options.team);

  await render_static_view(<Banner title={banner_title('teams', 'Snapshots')} />);
  if (snapshots.length === 0) {
    logger.info('No snapshots found.');
    return;
  }

  const rows: SnapshotRow[] = snapshots.map((snapshot) => ({
    snapshot_id: snapshot.snapshot_id,
    created_at: snapshot.created_at.toISOString(),
    channels: String(snapshot.channels.length),
    threads: String(snapshot.total_threads),
    size_bytes: String(snapshot.total_size_bytes),
  }));
  await render_static_view(<DataTable columns={snapshot_columns} rows={rows} />);
}

/** Backs up the requested teams in turn, stopping early on Ctrl+C. */
export async function execute_teams_backup(
  container: Container,
  options: TeamsBackupCommandOptions,
): Promise<void> {
  const tenant_id = resolve_tenant_id(container, options);
  // Built before any Graph call: invalid Object Lock flags must fail without a network call.
  const object_lock_request = build_object_lock_request(options);
  const team_ids = await resolve_backup_team_ids(container, tenant_id, options);

  const backup = container.get<TeamsBackupUseCase>(TEAMS_BACKUP_USE_CASE_TOKEN);
  const gate = install_interrupt_gate(
    '[!] Stopping after the current channel; the delta cursor is not advanced for an interrupted run',
  );
  const results: TeamsBackupResult[] = [];
  try {
    for (const team_id of team_ids) {
      const result = await backup.backup_team(tenant_id, team_id, {
        force_full: options.full ?? false,
        channel_id: options.channel,
        object_lock_request,
        should_interrupt: gate.should_interrupt,
      });
      results.push(result);
      if (result.interrupted || gate.should_interrupt()) break;
    }
  } finally {
    gate.dispose();
  }

  await render_static_view(<Banner title={banner_title('teams', 'Backup')} />);
  if (results.length > 1) {
    logger.info(`Backed up ${results.length} team(s)`);
  }

  for (const result of results) {
    await report_team_backup(result);
  }

  // Per-channel reporting already listed the errors and set the partial-run exit code.
  if (results.every((r) => r.summary.healthy)) {
    logger.success('Status: HEALTHY');
    return;
  }

  logger.error('Status: UNHEALTHY');
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

/** Renders the per-team section of a backup run. */
async function report_team_backup(result: TeamsBackupResult): Promise<void> {
  await render_static_view(
    <Box flexDirection="column">
      <KeyValueList
        items={[
          { label: 'Team', value: result.team_id },
          { label: 'Channels scanned', value: String(result.summary.channels_scanned) },
        ]}
      />
    </Box>,
  );

  if (result.snapshot) {
    logger.success(`Snapshot ${result.snapshot.snapshot_id} created`);
    const counters: SummaryEntry[] = [
      { label: 'changed', value: result.summary.threads_changed, color: 'cyan' },
      { label: 'stored', value: result.summary.threads_stored, color: 'green' },
      { label: 'dedup', value: result.summary.threads_deduplicated, color: 'yellow' },
    ];
    if (result.summary.threads_deleted > 0) {
      counters.push({ label: 'deleted', value: result.summary.threads_deleted, color: 'red' });
    }
    await render_static_view(<ResultSummary entries={counters} />);
  } else if (result.summary.no_snapshot_reason === 'no_content') {
    logger.warn('No Teams messages found. Nothing was backed up and no snapshot exists.');
  } else {
    logger.info('No Teams changes detected. Snapshot skipped.');
  }

  report_run_outcome(
    {
      errors: result.summary.errors,
      warnings: result.summary.warnings,
      interrupted: result.interrupted,
    },
    'channel',
  );
}
