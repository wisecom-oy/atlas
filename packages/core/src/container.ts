import { type Container } from 'inversify';
import {
  CATALOG_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
  ONEDRIVE_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_DELETION_USE_CASE_TOKEN,
  type SharePointReplicationUseCase,
  type OneDriveReplicationUseCase,
  type OneDriveDeletionUseCase,
  type SharePointDeletionUseCase,
} from '@wisecom/atlas-types';
import { CatalogService } from '@/services/catalog/catalog.service';
import { DeletionService } from '@/services/deletion/deletion.service';
import { OneDriveDeletionService } from '@/services/deletion/onedrive-deletion.service';
import { SharePointDeletionService } from '@/services/deletion/sharepoint-deletion.service';
import { VerificationService } from '@/services/verification/verification.service';
import { StatsService } from '@/services/stats/stats.service';
import { ReplicationService } from '@/services/replication/replication.service';
import { SharePointReplicationService } from '@/services/replication/sharepoint-replication.service';
import { OneDriveReplicationService } from '@/services/replication/onedrive-replication.service';

export function bind_core_services(container: Container): void {
  container.bind(CatalogService).toSelf();
  container.bind(CATALOG_USE_CASE_TOKEN).toService(CatalogService);
  container.bind(DeletionService).toSelf();
  container.bind(DELETION_USE_CASE_TOKEN).toService(DeletionService);
  container.bind(OneDriveDeletionService).toSelf();
  container
    .bind<OneDriveDeletionUseCase>(ONEDRIVE_DELETION_USE_CASE_TOKEN)
    .toService(OneDriveDeletionService);
  container.bind(SharePointDeletionService).toSelf();
  container
    .bind<SharePointDeletionUseCase>(SHAREPOINT_DELETION_USE_CASE_TOKEN)
    .toService(SharePointDeletionService);
  container.bind(VerificationService).toSelf();
  container.bind(VERIFICATION_USE_CASE_TOKEN).toService(VerificationService);
  container.bind(StatsService).toSelf();
  container.bind(STATS_USE_CASE_TOKEN).toService(StatsService);
  container.bind(ReplicationService).toSelf();
  container.bind(REPLICATION_USE_CASE_TOKEN).toService(ReplicationService);
  container.bind(SharePointReplicationService).toSelf();
  container
    .bind<SharePointReplicationUseCase>(SHAREPOINT_REPLICATION_USE_CASE_TOKEN)
    .toService(SharePointReplicationService);
  container.bind(OneDriveReplicationService).toSelf();
  container
    .bind<OneDriveReplicationUseCase>(ONEDRIVE_REPLICATION_USE_CASE_TOKEN)
    .toService(OneDriveReplicationService);
}
