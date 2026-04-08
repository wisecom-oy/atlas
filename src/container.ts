import 'reflect-metadata';
import { Container } from 'inversify';
import {
  MAILBOX_CONNECTOR_TOKEN,
  MANIFEST_REPOSITORY_TOKEN,
  TENANT_CONTEXT_FACTORY_TOKEN,
  RESTORE_CONNECTOR_TOKEN,
  MAILBOX_DISCOVERY_TOKEN,
} from '@/ports/tokens/outgoing.tokens';
import {
  BACKUP_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  RESTORE_USE_CASE_TOKEN,
  CATALOG_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  STORAGE_CHECK_USE_CASE_TOKEN,
  SAVE_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  STATUS_USE_CASE_TOKEN,
  TENANT_ORCHESTRATOR_TOKEN,
  REPLICATION_USE_CASE_TOKEN,
} from '@/ports/tokens/use-case.tokens';
import { GraphMailboxConnector } from '@/adapters/m365/graph-mailbox-connector.adapter';
import { GraphRestoreConnector } from '@/adapters/m365/graph-restore-connector.adapter';
import { create_graph_client, GRAPH_CLIENT_TOKEN } from '@/adapters/m365/graph-client.factory';
import { create_s3_client, S3_CLIENT_TOKEN } from '@/adapters/storage-s3/s3-client.factory';
import { S3ManifestRepository } from '@/adapters/storage-s3/s3-manifest-repository.adapter';
import { DefaultTenantContextFactory } from '@/adapters/tenant-context.factory';
import { MailboxSyncService } from '@/services/backup/mailbox-sync.service';
import { VerificationService } from '@/services/verification/verification.service';
import { RestoreService } from '@/services/restore/restore.service';
import { CatalogService } from '@/services/catalog/catalog.service';
import { DeletionService } from '@/services/deletion/deletion.service';
import { StorageCheckService } from '@/services/storage-check/storage-check.service';
import { SaveService } from '@/services/save/save.service';
import { StatsService } from '@/services/stats/stats.service';
import { DefaultTenantBackupOrchestrator } from '@/services/backup/tenant-backup-orchestrator';
import { MailboxStatusService } from '@/services/status/mailbox-status.service';
import { ReplicationService } from '@/services/replication/replication.service';
import { GraphMailboxDiscoveryAdapter } from '@/adapters/m365/graph-mailbox-discovery.adapter';
import type { AtlasConfig } from '@/utils/config';
import { load_config, ATLAS_CONFIG_TOKEN } from '@/utils/config';

/** Creates and configures the application-wide DI container. */
export function create_container(): Container {
  const config = load_config();
  return create_container_from_config(config);
}

/** Creates and configures the DI container from explicit AtlasConfig values. */
export function create_container_from_config(config: AtlasConfig): Container {
  const container = new Container();
  bind_config(container, config);
  bind_infrastructure(container);
  bind_adapters(container);
  bind_services(container);
  return container;
}

/** Binds AtlasConfig into the DI container. */
function bind_config(container: Container, config: AtlasConfig): void {
  container.bind<AtlasConfig>(ATLAS_CONFIG_TOKEN).toConstantValue(config);
}

/** Creates and binds infrastructure clients (Graph API, S3). */
function bind_infrastructure(container: Container): void {
  const config = container.get<AtlasConfig>(ATLAS_CONFIG_TOKEN);

  const graph_client = create_graph_client(config);
  container.bind(GRAPH_CLIENT_TOKEN).toConstantValue(graph_client);

  const s3_client = create_s3_client(config);
  container.bind(S3_CLIENT_TOKEN).toConstantValue(s3_client);
}

/** Binds adapters to their port tokens. */
function bind_adapters(container: Container): void {
  container.bind(MAILBOX_CONNECTOR_TOKEN).to(GraphMailboxConnector).inSingletonScope();
  container.bind(RESTORE_CONNECTOR_TOKEN).to(GraphRestoreConnector).inSingletonScope();
  container.bind(TENANT_CONTEXT_FACTORY_TOKEN).to(DefaultTenantContextFactory).inSingletonScope();
  container.bind(MANIFEST_REPOSITORY_TOKEN).to(S3ManifestRepository).inSingletonScope();
  container.bind(MAILBOX_DISCOVERY_TOKEN).to(GraphMailboxDiscoveryAdapter).inSingletonScope();
}

/** Binds service classes so Inversify can auto-resolve their constructor dependencies. */
function bind_services(container: Container): void {
  container.bind(MailboxSyncService).toSelf();
  container.bind(BACKUP_USE_CASE_TOKEN).toService(MailboxSyncService);
  container.bind(VerificationService).toSelf();
  container.bind(VERIFICATION_USE_CASE_TOKEN).toService(VerificationService);
  container.bind(RestoreService).toSelf();
  container.bind(RESTORE_USE_CASE_TOKEN).toService(RestoreService);
  container.bind(CatalogService).toSelf();
  container.bind(CATALOG_USE_CASE_TOKEN).toService(CatalogService);
  container.bind(DeletionService).toSelf();
  container.bind(DELETION_USE_CASE_TOKEN).toService(DeletionService);
  container.bind(StorageCheckService).toSelf();
  container.bind(STORAGE_CHECK_USE_CASE_TOKEN).toService(StorageCheckService);
  container.bind(SaveService).toSelf();
  container.bind(SAVE_USE_CASE_TOKEN).toService(SaveService);
  container.bind(StatsService).toSelf();
  container.bind(STATS_USE_CASE_TOKEN).toService(StatsService);
  container.bind(MailboxStatusService).toSelf();
  container.bind(STATUS_USE_CASE_TOKEN).toService(MailboxStatusService);
  container.bind(DefaultTenantBackupOrchestrator).toSelf();
  container.bind(TENANT_ORCHESTRATOR_TOKEN).toService(DefaultTenantBackupOrchestrator);
  container.bind(ReplicationService).toSelf();
  container.bind(REPLICATION_USE_CASE_TOKEN).toService(ReplicationService);
}
