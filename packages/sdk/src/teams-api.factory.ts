import type { Container } from 'inversify';
import type {
  TeamsApi,
  TeamsBackupUseCase,
  TeamsVerificationUseCase,
  TeamsCatalogUseCase,
  TeamsStatusUseCase,
  TeamsDeletionUseCase,
  TeamsSaveUseCase,
  QuarantineUseCase,
} from '@wisecom/atlas-types';
import {
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_VERIFICATION_USE_CASE_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
  TEAMS_STATUS_USE_CASE_TOKEN,
  TEAMS_DELETION_USE_CASE_TOKEN,
  TEAMS_SAVE_USE_CASE_TOKEN,
  TEAMS_QUARANTINE_USE_CASE_TOKEN,
} from '@wisecom/atlas-types';
import { camelize } from '@wisecom/atlas-types/public/case-convert';
import { run_with_cost_tracking } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { adapt_operation_options, adapt_required_operation_options } from '@/operation-options';

/** Builds the TeamsApi sub-namespace from the DI container. */
export function create_teams_api(tenant_id: string, container: Container): TeamsApi {
  const backup = container.get<TeamsBackupUseCase>(TEAMS_BACKUP_USE_CASE_TOKEN);
  const verification = container.get<TeamsVerificationUseCase>(TEAMS_VERIFICATION_USE_CASE_TOKEN);
  const catalog = container.get<TeamsCatalogUseCase>(TEAMS_CATALOG_USE_CASE_TOKEN);
  const status = container.get<TeamsStatusUseCase>(TEAMS_STATUS_USE_CASE_TOKEN);
  const deletion = container.get<TeamsDeletionUseCase>(TEAMS_DELETION_USE_CASE_TOKEN);
  const save = container.get<TeamsSaveUseCase>(TEAMS_SAVE_USE_CASE_TOKEN);
  const quarantine = container.get<QuarantineUseCase>(TEAMS_QUARANTINE_USE_CASE_TOKEN);

  return {
    async backup(team_id, options) {
      // Tracked like Outlook: the cost covers every Graph call the backup made, graphCost included.
      const [result, cost_result] = await run_with_cost_tracking(() =>
        backup.backup_team(tenant_id, team_id, adapt_operation_options(options)),
      );
      return camelize({ ...result, graph_cost: cost_result });
    },
    async verify(team_id, snapshot_id, options) {
      return camelize(
        await verification.verify_teams_snapshot(
          tenant_id,
          team_id,
          snapshot_id,
          adapt_operation_options(options),
        ),
      );
    },
    async listTeams() {
      return catalog.list_teams(tenant_id);
    },
    async listSnapshots(team_id) {
      return camelize(await catalog.list_teams_snapshots(tenant_id, team_id));
    },
    async status() {
      return camelize(await status.check_teams_status(tenant_id));
    },
    async delete(team_id, snapshot_id) {
      return camelize(
        snapshot_id === undefined
          ? await deletion.delete_team_data(tenant_id, team_id)
          : await deletion.delete_snapshot(tenant_id, team_id, snapshot_id),
      );
    },
    async save(team_id, options) {
      return camelize(
        await save.save_snapshot(
          tenant_id,
          team_id,
          adapt_required_operation_options(options, 'teams.save()'),
        ),
      );
    },
    async quarantine(storage_key) {
      return camelize(await quarantine.quarantine_unreadable_object(tenant_id, storage_key));
    },
  };
}
