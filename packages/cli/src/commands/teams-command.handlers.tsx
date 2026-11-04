import type { Container } from 'inversify';
import { Box } from 'ink';
import { logger } from '@wisecom/atlas-core';
import type {
  TeamsBackupOptions,
  TeamsBackupResult,
  TeamsBackupUseCase,
  TeamsCatalogUseCase,
} from '@wisecom/atlas-types';
import {
  AuthError,
  TEAMS_BACKUP_USE_CASE_TOKEN,
  THROTTLE_COORDINATOR_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { build_object_lock_request } from '@/command-object-lock';
import { EXIT_PARTIAL, report_run_outcome } from '@/command-run-outcome';
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
  const listing = await catalog.list_teams_snapshots(tenant_id, options.team);
  const snapshots = listing.indexes;

  await render_static_view(<Banner title={banner_title('teams', 'Snapshots')} />);
  if (listing.unreadable_keys.length > 0) {
    logger.warn(
      `${listing.unreadable_keys.length} snapshot index(es) could not be read and are not listed: ${listing.unreadable_keys.join(', ')}`,
    );
  }
  if (listing.unsupported_keys.length > 0) {
    logger.warn(
      `${listing.unsupported_keys.length} snapshot index(es) use a newer format and are not listed: ${listing.unsupported_keys.join(', ')}`,
    );
  }
  if (snapshots.length === 0) {
    logger.info('No snapshots found.');
    return;
  }

  const rows: SnapshotRow[] = snapshots.map((snapshot) => ({
    snapshot_id: snapshot.snapshot_id,
    created_at: snapshot.created_at.toISOString(),
    channels: String(snapshot.channels.length),
    threads: String(snapshot.totals.thread_count),
    size_bytes: String(snapshot.totals.size_bytes),
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
  assert_channel_scope(options);
  const team_ids = await resolve_backup_team_ids(container, tenant_id, options);

  const backup = container.get<TeamsBackupUseCase>(TEAMS_BACKUP_USE_CASE_TOKEN);
  const gate = install_interrupt_gate(
    "Stopping after the current thread; threads already stored are kept and the interrupted channel's delta link is not advanced",
  );
  await render_static_view(<Banner title={banner_title('teams', 'Backup')} />);
  if (team_ids.length > 1) {
    logger.info(`Backing up ${team_ids.length} team(s)`);
  }

  let run: TeamsBackupRun;
  try {
    run = await run_team_backups(
      backup,
      tenant_id,
      team_ids,
      {
        force_full: options.full ?? false,
        channel_id: options.channel,
        object_lock_request,
        should_interrupt: gate.should_interrupt,
        abort_signal: gate.abort_signal,
      },
      report_team_backup,
    );
  } finally {
    gate.dispose();
  }

  // Ctrl+C aborts the request but not the cooldown the run raised. That timer is not unref'd, so
  // it would keep the process alive until the Retry-After expires. Unbinding the coordinator runs
  // its deactivation hook, which clears the fence timers.
  if (gate.abort_signal.aborted && container.isBound(THROTTLE_COORDINATOR_TOKEN)) {
    await container.unbindAsync(THROTTLE_COORDINATOR_TOKEN);
  }

  report_run_outcome(
    { errors: run.failed_teams, warnings: [], interrupted: run.interrupted },
    'team',
  );
  if (run.fatal) throw run.fatal;

  // Per-channel reporting already listed the errors and set the partial-run exit code.
  if (run.failed_teams.length === 0 && run.all_healthy) {
    logger.success('Status: HEALTHY');
    return;
  }

  logger.error('Status: UNHEALTHY');
  // A ledger-only run has no error entry, so the verdict sets the exit code itself.
  process.exitCode = EXIT_PARTIAL;
}

/** Outcome of backing up a list of teams in turn. Each team's full result is reported, not kept. */
interface TeamsBackupRun {
  all_healthy: boolean;
  interrupted: boolean;
  failed_teams: string[];
  fatal?: Error;
}

/**
 * Backs up each team in turn and hands each result to `report` as it finishes. A failing team is
 * recorded and the rest still run. A single-team run or an auth failure stops the run and is
 * rethrown after reporting. Ctrl+C aborting the team in flight stops the run without recording
 * the cancelled team as failed.
 */
async function run_team_backups(
  backup: TeamsBackupUseCase,
  tenant_id: string,
  team_ids: string[],
  base_options: TeamsBackupOptions,
  report: (result: TeamsBackupResult) => Promise<void>,
): Promise<TeamsBackupRun> {
  const run: TeamsBackupRun = { all_healthy: true, interrupted: false, failed_teams: [] };
  for (const team_id of team_ids) {
    try {
      const result = await backup.backup_team(tenant_id, team_id, base_options);
      await report(result);
      run.all_healthy = run.all_healthy && result.summary.healthy;
      if (result.interrupted || base_options.should_interrupt?.()) break;
    } catch (thrown) {
      if (base_options.abort_signal?.aborted) {
        run.all_healthy = false;
        run.interrupted = true;
        break;
      }
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      if (team_ids.length === 1 || error instanceof AuthError) {
        run.fatal = error;
        break;
      }
      run.failed_teams.push(`${team_id}: ${error.message}`);
    }
  }
  return run;
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
function assert_channel_scope(options: TeamsBackupCommandOptions): void {
  if (options.channel === undefined) return;
  if (options.all || options.team?.length !== 1) {
    throw new Error('--channel requires exactly one --team');
  }
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
      { label: 'stored', value: result.summary.messages_stored, color: 'green' },
      { label: 'dedup', value: result.summary.messages_deduplicated, color: 'yellow' },
      { label: 'hosted', value: result.summary.hosted_content_stored, color: 'green' },
    ];
    if (result.summary.threads_deleted > 0) {
      counters.push({ label: 'deleted', value: result.summary.threads_deleted, color: 'red' });
    }
    await render_static_view(<ResultSummary entries={counters} />);
  } else if (result.summary.healthy && result.summary.no_snapshot_reason === 'no_content') {
    logger.warn('No Teams messages found. Nothing was backed up and no snapshot exists.');
  } else if (result.summary.healthy) {
    // Unhealthy runs report their failure through the run outcome, not as "no changes".
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
