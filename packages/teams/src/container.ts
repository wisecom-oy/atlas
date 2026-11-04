import { type Container } from 'inversify';
import {
  TEAMS_BACKUP_USE_CASE_TOKEN,
  TEAMS_CATALOG_USE_CASE_TOKEN,
  TEAMS_CONNECTOR_TOKEN,
  TEAMS_DELETION_USE_CASE_TOKEN,
  TEAMS_CHANNEL_CURSOR_REPOSITORY_TOKEN,
  TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN,
  TEAMS_INDEX_REPOSITORY_TOKEN,
  TEAMS_STATUS_USE_CASE_TOKEN,
  TEAMS_VERIFICATION_USE_CASE_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  THROTTLE_COORDINATOR_TOKEN,
} from '@wisecom/atlas-types';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';
import { scope_connector_throttling } from '@wisecom/atlas-m365-graph';
import { GraphTeamsConnector } from '@/adapters/graph-teams-connector.adapter';
import { S3TeamsChannelCursorRepository } from '@/adapters/s3-teams-channel-cursor-repository.adapter';
import { S3TeamsChannelShardRepository } from '@/adapters/s3-teams-channel-shard-repository.adapter';
import { S3TeamsIndexRepository } from '@/adapters/s3-teams-index-repository.adapter';
import { TeamsBackupService } from '@/services/backup/backup.service';
import { TeamsCatalogService } from '@/services/catalog/catalog.service';
import { TeamsDeletionService } from '@/services/deletion/deletion.service';
import { TeamsStatusService } from '@/services/status/status.service';
import { TeamsVerificationService } from '@/services/verification/verification.service';

/** Registers Teams-specific DI bindings. Requires TENANT_CONTEXT_FACTORY_TOKEN to be bound first. */
export function bind_teams(container: Container): void {
  if (!container.isBound(TENANT_CONTEXT_FACTORY_TOKEN)) {
    throw new Error(
      'TENANT_CONTEXT_FACTORY_TOKEN must be bound before calling bind_teams. ' +
        'Call bind_s3_storage() first.',
    );
  }
  container.bind(GraphTeamsConnector).toSelf().inSingletonScope();
  container
    .bind(TEAMS_CONNECTOR_TOKEN)
    .toDynamicValue((ctx) =>
      scope_connector_throttling(
        ctx.get(GraphTeamsConnector),
        ctx.get<ThrottleCoordinator>(THROTTLE_COORDINATOR_TOKEN),
        'teams',
      ),
    )
    .inSingletonScope();
  container.bind(TEAMS_INDEX_REPOSITORY_TOKEN).to(S3TeamsIndexRepository).inSingletonScope();
  container
    .bind(TEAMS_CHANNEL_SHARD_REPOSITORY_TOKEN)
    .to(S3TeamsChannelShardRepository)
    .inSingletonScope();
  container
    .bind(TEAMS_CHANNEL_CURSOR_REPOSITORY_TOKEN)
    .to(S3TeamsChannelCursorRepository)
    .inSingletonScope();
  container.bind(TEAMS_BACKUP_USE_CASE_TOKEN).to(TeamsBackupService).inSingletonScope();
  container.bind(TEAMS_VERIFICATION_USE_CASE_TOKEN).to(TeamsVerificationService).inSingletonScope();
  container.bind(TEAMS_CATALOG_USE_CASE_TOKEN).to(TeamsCatalogService).inSingletonScope();
  container.bind(TEAMS_STATUS_USE_CASE_TOKEN).to(TeamsStatusService).inSingletonScope();
  container.bind(TEAMS_DELETION_USE_CASE_TOKEN).to(TeamsDeletionService).inSingletonScope();
}
