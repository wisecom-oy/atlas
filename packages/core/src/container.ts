import { type Container } from 'inversify';
import {
  CATALOG_USE_CASE_TOKEN,
  DELETION_USE_CASE_TOKEN,
  DEK_REWRAP_USE_CASE_TOKEN,
  OLD_WRAPPER_PURGE_USE_CASE_TOKEN,
  TENANT_SET_REWRAP_USE_CASE_TOKEN,
  VERIFICATION_USE_CASE_TOKEN,
  STATS_USE_CASE_TOKEN,
  STORAGE_USAGE_USE_CASE_TOKEN,
  ONEDRIVE_DELETION_USE_CASE_TOKEN,
  SHAREPOINT_DELETION_USE_CASE_TOKEN,
  OWNER_LEASE_TOKEN,
  OUTLOOK_SNAPSHOT_PRUNE_USE_CASE_TOKEN,
  type OwnerExclusion,
  type SnapshotPruneUseCase,
  type OwnerLeasePort,
  type OneDriveDeletionUseCase,
  type SharePointDeletionUseCase,
} from '@wisecom/atlas-types';
import { CatalogService } from '@/services/catalog/catalog.service';
import { DeletionService } from '@/services/deletion/deletion.service';
import { DekRewrapService } from '@/services/keys/dek-rewrap.service';
import { StorageOwnerLeases } from '@/services/lease/storage-owner-leases';
import { ExclusionOwnerLeases } from '@/services/lease/exclusion-owner-leases';
import { OneDriveDeletionService } from '@/services/deletion/onedrive-deletion.service';
import { SharePointDeletionService } from '@/services/deletion/sharepoint-deletion.service';
import { VerificationService } from '@/services/verification/verification.service';
import { StatsService } from '@/services/stats/stats.service';
import { StorageUsageService } from '@/services/stats/storage-usage.service';
import { TenantSetRewrapService } from '@/services/keys/tenant-set-rewrap.service';
import { OldWrapperPurgeService } from '@/services/keys/old-wrapper-purge.service';
import { OutlookSnapshotPruneService } from '@/services/retention/outlook-snapshot-prune.service';

/**
 * Binds the core services. `owner_exclusion`, when given, replaces the storage owner lease: the
 * host's own exclusion or the CLI's in-process one (issue #974).
 */
export function bind_core_services(container: Container, owner_exclusion?: OwnerExclusion): void {
  const leases: OwnerLeasePort =
    owner_exclusion === undefined
      ? new StorageOwnerLeases()
      : new ExclusionOwnerLeases(owner_exclusion);
  container.bind<OwnerLeasePort>(OWNER_LEASE_TOKEN).toConstantValue(leases);
  container.bind(CatalogService).toSelf();
  container.bind(CATALOG_USE_CASE_TOKEN).toService(CatalogService);
  container.bind(DeletionService).toSelf();
  container.bind(DELETION_USE_CASE_TOKEN).toService(DeletionService);
  container.bind(DekRewrapService).toSelf();
  container.bind(DEK_REWRAP_USE_CASE_TOKEN).toService(DekRewrapService);
  container.bind(TenantSetRewrapService).toSelf();
  container.bind(TENANT_SET_REWRAP_USE_CASE_TOKEN).toService(TenantSetRewrapService);
  container.bind(OldWrapperPurgeService).toSelf();
  container.bind(OLD_WRAPPER_PURGE_USE_CASE_TOKEN).toService(OldWrapperPurgeService);
  container.bind(OneDriveDeletionService).toSelf();
  container
    .bind<OneDriveDeletionUseCase>(ONEDRIVE_DELETION_USE_CASE_TOKEN)
    .toService(OneDriveDeletionService);
  container.bind(SharePointDeletionService).toSelf();
  container
    .bind<SharePointDeletionUseCase>(SHAREPOINT_DELETION_USE_CASE_TOKEN)
    .toService(SharePointDeletionService);
  container.bind(OutlookSnapshotPruneService).toSelf();
  container
    .bind<SnapshotPruneUseCase>(OUTLOOK_SNAPSHOT_PRUNE_USE_CASE_TOKEN)
    .toService(OutlookSnapshotPruneService);
  container.bind(VerificationService).toSelf();
  container.bind(VERIFICATION_USE_CASE_TOKEN).toService(VerificationService);
  container.bind(StatsService).toSelf();
  container.bind(STATS_USE_CASE_TOKEN).toService(StatsService);
  container.bind(StorageUsageService).toSelf();
  container.bind(STORAGE_USAGE_USE_CASE_TOKEN).toService(StorageUsageService);
}
