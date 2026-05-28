export type { AtlasInstance, AtlasInstanceConfig } from '@/ports/atlas/use-case.port';
export type { BucketStats, MailboxStats, FolderStats, MonthlyBreakdown } from '@/domain/stats';
export type { MailboxStatusResult, FolderStatus } from '@/ports/status/use-case.port';
export type { ReplicationResult, ReplicationStatusRecord } from '@/domain/replication';
export type { StorageTarget, StorageTargetConfig } from '@/ports/replication/storage-target.port';
export type { StorageTargetSdkConfig } from '@/adapters/storage-target.factory';
export type { SyncResult } from '@/ports/backup/use-case.port';
export type { RestoreResult } from '@/ports/restore/use-case.port';
export type { OperationCost, ServicePoolCost, GraphServicePool } from '@/domain/graph-cost';
export type {
  GraphServiceLimits,
  OutlookServiceLimits,
  SharePointServiceLimits,
  IdentityServiceLimits,
} from '@/domain/graph-service-limits';
export { GRAPH_SERVICE_LIMITS } from '@/domain/graph-service-limits-values';
export { createAtlasInstance } from '@/adapters/sdk/atlas-instance.adapter';
export { create_storage_target as createStorageTarget } from '@/adapters/storage-target.factory';
