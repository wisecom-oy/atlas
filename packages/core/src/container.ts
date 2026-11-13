import { type Container } from 'inversify';
import {
  CATALOG_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  DEK_REWRAP_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  STORAGE_USAGE_USE_CASE_TOKEN,
  REPLICATION_USE_CASE_TOKEN,
  SHAREPOINT_REPLICATION_USE_CASE_TOKEN,
  ONEDRIVE_REPLICATION_USE_CASE_TOKEN,
  ONEDRIVE_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_DELETION_USE_CASE_TOKEN,
  OWNER_LEASE_TOKEN,
  type OwnerLeasePort,
  type SharePointReplicationUseCase,
  type OneDriveReplicationUseCase,
  type OneDriveDeletionUseCase,
  type SharePointDeletionUseCase,
} from '@wisecom/atlas-types';
import { CatalogService } from '@/services/catalog/catalog.service';
import { DeletionService } from '@/services/deletion/deletion.service';
import { DekRewrapService } from '@/services/keys/dek-rewrap.service';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';
import { OneDriveDeletionService } from '@/services/deletion/onedrive-deletion.service';
import { SharePointDeletionService } from '@/services/deletion/sharepoint-deletion.service';
import { VerificationService } from '@/services/verification/verification.service';
import { StatsService } from '@/services/stats/stats.service';
import { StorageUsageService } from '@/services/stats/storage-usage.service';
import { ReplicationService } from '@/services/replication/replication.service';
import { SharePointReplicationService } from '@/services/replication/sharepoint-replication.service';
import { OneDriveReplicationService } from '@/services/replication/onedrive-replication.service';
import { LeasedReplicationService } from '@/services/replication/leased-replication.service';
import { LeasedSharePointReplicationService } from '@/services/replication/leased-sharepoint-replication.service';
import { LeasedOneDriveReplicationService } from '@/services/replication/leased-onedrive-replication.service';

export function bind_core_services(container: Container): void {
  container.bind<OwnerLeasePort>(OWNER_LEASE_TOKEN).toConstantValue(new StorageOwnerLeases());
  container.bind(CatalogService).toSelf();
  container.bind(CATALOG_USE_CASE_TOKEN).toService(CatalogService);
  container.bind(DeletionService).toSelf();
  container.bind(DELETION_USE_CASE_TOKEN).toService(DeletionService);
  container.bind(DekRewrapService).toSelf();
  container.bind(DEK_REWRAP_USE_CASE_TOKEN).toService(DekRewrapService);
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
  container.bind(StorageUsageService).toSelf();
  container.bind(STORAGE_USAGE_USE_CASE_TOKEN).toService(StorageUsageService);
  container.bind(ReplicationService).toSelf();
  container.bind(SharePointReplicationService).toSelf();
  container.bind(OneDriveReplicationService).toSelf();
  // The use cases the rest of the process resolves take the owner lease, then delegate (issue #740).
  container.bind(LeasedReplicationService).toSelf();
  container.bind(REPLICATION_USE_CASE_TOKEN).toService(LeasedReplicationService);
  container.bind(LeasedSharePointReplicationService).toSelf();
  container
    .bind<SharePointReplicationUseCase>(SHAREPOINT_REPLICATION_USE_CASE_TOKEN)
    .toService(LeasedSharePointReplicationService);
  container.bind(LeasedOneDriveReplicationService).toSelf();
  container
    .bind<OneDriveReplicationUseCase>(ONEDRIVE_REPLICATION_USE_CASE_TOKEN)
    .toService(LeasedOneDriveReplicationService);
}
