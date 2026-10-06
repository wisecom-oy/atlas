import type {
  ObjectLockRequest as InternalObjectLockRequest,
  StorageOwnerUsage as InternalStorageOwnerUsage,
  StorageUsage as InternalStorageUsage,
  StorageUsageTotals as InternalStorageUsageTotals,
} from '@wisecom/atlas-types';
import type { Camelize } from '@wisecom/atlas-types/public/case-convert';

export type { GraphServiceLimits, OperationCost, ServicePoolCost } from '@/public-values';

/** Requested Object Lock protection, as a caller writes it: `{ mode, retentionDays }`. */
export type ObjectLockRequest = Camelize<InternalObjectLockRequest>;

/** Physical usage of a tenant bucket or replica, as `getStorageUsage` returns it. */
export type StorageUsage = Camelize<InternalStorageUsage>;

/** Counts for one workload or owner within a `StorageUsage`. */
export type StorageUsageTotals = Camelize<InternalStorageUsageTotals>;

/** One owner or site row of the `owner` breakdown. */
export type StorageOwnerUsage = Camelize<InternalStorageOwnerUsage>;
