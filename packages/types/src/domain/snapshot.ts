export interface Snapshot {
  readonly id: string;
  readonly tenant_id: string;
  /** Entra object ID (UUID) of the mailbox owner; used as the storage partition key. */
  readonly owner_id: string;
  readonly owner_email?: string;
  readonly owner_display_name?: string;
  readonly started_at: Date;
  readonly completed_at?: Date;
  readonly object_count: number;
  readonly status: SnapshotStatus;
}

export enum SnapshotStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
