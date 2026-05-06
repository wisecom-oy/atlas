export interface RestoreRequest {
  readonly id: string;
  readonly tenant_id: string;
  readonly owner_id: string;
  readonly snapshot_id: string;
  readonly target_owner_id?: string;
  readonly requested_at: Date;
  readonly status: RestoreStatus;
  readonly restored_count: number;
  readonly error_message?: string;
}

export enum RestoreStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
