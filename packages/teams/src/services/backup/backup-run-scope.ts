import type {
  HeldOwnerLease,
  TeamsChannelCheckpointRepository,
  TeamsConnector,
  TeamsHostedRef,
  TeamsMessageLocator,
  TenantContext,
} from '@wisecom/atlas-types';

/** Work counts one backup run accumulates for its summary. */
export interface BackupCounters {
  channels_full_read: number;
  threads_changed: number;
  messages_stored: number;
  messages_deduplicated: number;
  threads_deleted: number;
  hosted_content_stored: number;
}

/** Reports the roots a channel applied, so the progress line can count them. */
export interface BackupProgress {
  roots_applied(channel_id: string, count: number): void;
}

/**
 * Records hosted content as soon as its blob is stored, before the message that references it is
 * recorded, so a read stopped in between reuses the blob on resume instead of downloading it again.
 */
export interface HostedJournal {
  lookup(locator: TeamsMessageLocator, hosted_id: string): TeamsHostedRef | undefined;
  record(locator: TeamsMessageLocator, hosted_id: string, ref: TeamsHostedRef): Promise<void>;
}

/** Everything a channel and thread step needs from the run that owns it. */
export interface BackupRunScope {
  readonly ctx: TenantContext;
  readonly connector: TeamsConnector;
  readonly tenant_id: string;
  readonly team_id: string;
  /** ISO timestamp of the run, stamped on every entry the run writes. */
  readonly backup_at: string;
  readonly counters: BackupCounters;
  readonly should_interrupt: () => boolean;
  /** Resumable per-channel checkpoints, written while a channel's pages are applied. */
  readonly checkpoints: TeamsChannelCheckpointRepository;
  /**
   * The context checkpoints are written through. Checkpoints are rewritten every page and deleted
   * when the read finishes, so they skip the run's Object Lock. Defaults to `ctx`.
   */
  readonly checkpoint_ctx?: TenantContext | undefined;
  /** The team's lease, checked before a checkpoint is advanced or discarded (issue #623). */
  readonly lease: HeldOwnerLease;
  /** The channel read's hosted journal. Set per channel while its pages are applied. */
  readonly hosted_journal?: HostedJournal | undefined;
  readonly progress: BackupProgress;
  /** True for `--full`: ignore stored files folders and delta links. */
  readonly force_full: boolean;
}

/** Returns zeroed counters for a new run. */
export function create_backup_counters(): BackupCounters {
  return {
    channels_full_read: 0,
    threads_changed: 0,
    messages_stored: 0,
    messages_deduplicated: 0,
    threads_deleted: 0,
    hosted_content_stored: 0,
  };
}
