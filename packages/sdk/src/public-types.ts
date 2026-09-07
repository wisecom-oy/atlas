import type { ObjectLockRequest as InternalObjectLockRequest } from '@wisecom/atlas-types';
import type { Camelize } from '@wisecom/atlas-types/public/case-convert';

export type { GraphServiceLimits, OperationCost, ServicePoolCost } from '@/public-values';

/** Requested Object Lock protection, as a caller writes it: `{ mode, retentionDays }`. */
export type ObjectLockRequest = Camelize<InternalObjectLockRequest>;
