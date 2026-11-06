import { randomBytes } from 'node:crypto';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  TEAMS_FORMAT_VERSION,
  UnreadableContentError,
  UnsupportedFormatVersionError,
  type FailedItemLedger,
  type TeamsChannelCheckpointHead,
  type TeamsChannelCheckpointSegment,
  type TeamsCheckpointMode,
  type TeamsCheckpointPhase,
  type TeamsHostedRef,
  type TeamsThread,
  type TenantContext,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import type { HostedRecheck } from '@/services/backup/hosted-recheck';
import type { RootApplyState } from '@/services/backup/root-apply-outcome';

/** What a channel's read starts from: the previous shard's threads and the stored cursor state. */
export interface ChannelRunStart {
  /** Previous index entry's shard key; undefined for a new channel. */
  readonly baseline_shard_key: string | undefined;
  readonly stored_link: string | undefined;
  readonly threads: Record<string, TeamsThread>;
  readonly failed_roots: FailedItemLedger;
  readonly hosted_recheck: HostedRecheck;
}

/** The live state of one channel's read: what its pages have applied and where it resumes. */
export interface ChannelRun {
  readonly channel_id: string;
  readonly start_link: string | undefined;
  readonly baseline_shard_key: string | undefined;
  /** Random per run, so segment names from an earlier run never collide with this one's. */
  readonly stamp: string;
  /** True when a valid checkpoint was loaded and this run continues it. */
  readonly resumed: boolean;
  mode: TeamsCheckpointMode;
  phase: TeamsCheckpointPhase;
  next_page: string | undefined;
  pending_delta_link: string | undefined;
  segments: string[];
  /** Every root the read has applied so far, across all phases. */
  readonly seen: Set<string>;
  readonly state: RootApplyState;
  /** Hosted content stored by this read, journaled before its message was recorded. */
  readonly hosted: Map<string, TeamsHostedRef>;
  /** The head as last saved, or as loaded on resume. Undefined before the first save. */
  head: TeamsChannelCheckpointHead | undefined;
}

/** What one step saves: the threads to write, the ids to mark as seen, and journaled hosted refs. */
export interface RunStep {
  readonly threads: string[];
  readonly seen: string[];
  readonly hosted?: Record<string, TeamsHostedRef>;
}

/**
 * Opens a channel's read. Resumes the stored checkpoint when it matches this run's baseline, link,
 * and mode; otherwise starts fresh from the stored state.
 */
export async function open_channel_run(
  scope: BackupRunScope,
  channel_id: string,
  start: ChannelRunStart,
  mode: TeamsCheckpointMode,
  has_email: boolean,
): Promise<ChannelRun> {
  const loaded = await load_checkpoint(scope, channel_id, start, mode);
  if (loaded !== undefined) {
    return resumed_run(channel_id, start, loaded);
  }
  return {
    channel_id,
    start_link: start.stored_link,
    baseline_shard_key: start.baseline_shard_key,
    stamp: randomBytes(4).toString('hex'),
    resumed: false,
    mode,
    phase: has_email ? 'delta' : 'list',
    next_page: undefined,
    pending_delta_link: undefined,
    segments: [],
    seen: new Set(),
    state: {
      threads: { ...start.threads },
      failed_roots: start.failed_roots,
      hosted_recheck: { ...start.hosted_recheck },
      errors: [],
      warnings: [],
    },
    hosted: new Map(),
    head: undefined,
  };
}

/**
 * Saves one step of a read: its roots as a new segment, then the head that points past it. A crash
 * between the two replays only this step, and the replay is idempotent.
 */
export async function flush_channel_run(
  scope: BackupRunScope,
  run: ChannelRun,
  step: RunStep,
): Promise<void> {
  if (step.threads.length > 0 || step.seen.length > 0 || step.hosted !== undefined) {
    const name = `seg-${run.stamp}-${run.segments.length}`;
    const segment: TeamsChannelCheckpointSegment = {
      threads: Object.fromEntries(step.threads.map((id) => [id, thread_or_null(run, id)])),
      seen: [...step.seen],
      ...(step.hosted === undefined ? {} : { hosted: step.hosted }),
    };
    await scope.checkpoints.save_segment(
      checkpoint_ctx(scope),
      scope.team_id,
      run.channel_id,
      name,
      segment,
    );
    run.segments.push(name);
  }
  for (const id of step.seen) run.seen.add(id);
  run.head = build_head(scope, run);
  await scope.checkpoints.save_head(checkpoint_ctx(scope), run.head);
}

/** The context checkpoint objects are read and written through. */
function checkpoint_ctx(scope: BackupRunScope): TenantContext {
  return scope.checkpoint_ctx ?? scope.ctx;
}

/** The thread a root holds in the working set, or null when the root has left it. */
function thread_or_null(run: ChannelRun, id: string): TeamsThread | null {
  const thread: TeamsThread | undefined = run.state.threads[id];
  return thread ?? null;
}

/** Builds the head that describes the run as it stands now. */
function build_head(scope: BackupRunScope, run: ChannelRun): TeamsChannelCheckpointHead {
  return {
    format_version: TEAMS_FORMAT_VERSION,
    team_id: scope.team_id,
    channel_id: run.channel_id,
    baseline_shard_key: run.baseline_shard_key,
    start_link: run.start_link,
    mode: run.mode,
    phase: run.phase,
    next_page: run.next_page,
    pending_delta_link: run.pending_delta_link,
    segments: [...run.segments],
    failed_roots: run.state.failed_roots,
    hosted_recheck: run.state.hosted_recheck,
    updated_at: scope.backup_at,
  };
}

/** A checkpoint that matches this run, with its segments read in write order. */
interface LoadedCheckpoint {
  readonly head: TeamsChannelCheckpointHead;
  readonly segments: TeamsChannelCheckpointSegment[];
}

/**
 * Loads the channel's checkpoint when it can continue this run. Any mismatch, unreadable part, or
 * missing segment deletes the checkpoint and returns undefined, so the read starts fresh.
 */
async function load_checkpoint(
  scope: BackupRunScope,
  channel_id: string,
  start: ChannelRunStart,
  mode: TeamsCheckpointMode,
): Promise<LoadedCheckpoint | undefined> {
  const repo = scope.checkpoints;
  try {
    const head = await repo.load_head(checkpoint_ctx(scope), scope.team_id, channel_id);
    if (head === undefined) return undefined;
    if (!matches_run(head, start, mode)) {
      return discard_checkpoint(scope, channel_id, 'it belongs to a different read');
    }
    const segments: TeamsChannelCheckpointSegment[] = [];
    for (const name of head.segments) {
      segments.push(
        await repo.load_segment(checkpoint_ctx(scope), scope.team_id, channel_id, name),
      );
    }
    return { head, segments };
  } catch (err) {
    if (err instanceof UnreadableContentError || err instanceof UnsupportedFormatVersionError) {
      return discard_checkpoint(scope, channel_id, err.message);
    }
    throw err;
  }
}

/**
 * Whether a saved head continues the read this run is about to make. A full-read head also
 * continues a delta run: a full read covers everything a delta read would, and a delta link Graph
 * rejected leaves a full-read checkpoint while the cursor keeps the rejected link (#23).
 */
function matches_run(
  head: TeamsChannelCheckpointHead,
  start: ChannelRunStart,
  mode: TeamsCheckpointMode,
): boolean {
  return (
    head.baseline_shard_key === start.baseline_shard_key &&
    head.start_link === start.stored_link &&
    (head.mode === mode || head.mode === 'full')
  );
}

/** Deletes a checkpoint that cannot be resumed. Deleting is always safe: the read starts over. */
async function discard_checkpoint(
  scope: BackupRunScope,
  channel_id: string,
  reason: string,
): Promise<undefined> {
  logger.warn(`Teams channel ${channel_id}: discarding its checkpoint (${reason})`);
  await scope.checkpoints.delete_channel(checkpoint_ctx(scope), scope.team_id, channel_id);
  return undefined;
}

/** Rebuilds a run from a matching checkpoint: the baseline threads overlaid by every segment. */
function resumed_run(
  channel_id: string,
  start: ChannelRunStart,
  loaded: LoadedCheckpoint,
): ChannelRun {
  const { head } = loaded;
  const threads: Record<string, TeamsThread> = { ...start.threads };
  const seen = new Set<string>();
  const hosted = new Map<string, TeamsHostedRef>();
  for (const segment of loaded.segments) {
    for (const [id, thread] of Object.entries(segment.threads)) {
      if (thread === null) {
        delete threads[id];
      } else {
        threads[id] = thread;
      }
    }
    for (const id of segment.seen) seen.add(id);
    for (const [key, ref] of Object.entries(segment.hosted ?? {})) hosted.set(key, ref);
  }
  return {
    channel_id,
    start_link: head.start_link,
    baseline_shard_key: head.baseline_shard_key,
    stamp: randomBytes(4).toString('hex'),
    resumed: true,
    mode: head.mode,
    // A finished read resumes at its retry step, so its roots are not fetched again.
    phase: head.phase === 'done' ? 'retry' : head.phase,
    next_page: head.next_page,
    pending_delta_link: head.pending_delta_link,
    segments: [...head.segments],
    seen,
    state: {
      threads,
      failed_roots: head.failed_roots,
      hosted_recheck: head.hosted_recheck,
      errors: [],
      warnings: [],
    },
    hosted,
    head,
  };
}
