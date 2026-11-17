import type { FailedItemLedger } from '@/domain/shared/failed-item';
import type { TEAMS_FORMAT_VERSION, TeamsHostedRef, TeamsThread } from '@/domain/teams/manifest';

/** Which read a checkpoint belongs to: a delta read from a stored link, or a full read. */
export type TeamsCheckpointMode = 'delta' | 'full';

/**
 * The phase a checkpointed read is in. `delta` pages the channel's delta feed, `list` pages
 * `/messages` (full reads only), `retry` re-applies ledger and hosted-recheck roots, and `done`
 * marks a finished read whose checkpoint has not been deleted yet.
 */
export type TeamsCheckpointPhase = 'delta' | 'list' | 'retry' | 'done';

/**
 * Resume state of one channel's read, stored at `teams/_meta/{team}/checkpoints/{channel}/head.json`.
 * Working threads are the previous shard's threads overlaid by the segments named in `segments`.
 */
export interface TeamsChannelCheckpointHead {
  readonly format_version: typeof TEAMS_FORMAT_VERSION;
  readonly team_id: string;
  readonly channel_id: string;
  /** Previous entry's shard key the checkpoint was built on; undefined for a new channel. */
  readonly baseline_shard_key: string | undefined;
  /** Stored cursor link the read started from; undefined when the channel had none. */
  readonly start_link: string | undefined;
  readonly mode: TeamsCheckpointMode;
  readonly phase: TeamsCheckpointPhase;
  /** Page URL to read next in the current phase; undefined starts the phase from its first page. */
  readonly next_page: string | undefined;
  /** Delta link taken from the delta phase; saved with the cursor once the read completes. */
  readonly pending_delta_link: string | undefined;
  /** Segment object names, in write order. Append-only until the checkpoint is deleted. */
  readonly segments: string[];
  readonly failed_roots: FailedItemLedger;
  readonly hosted_recheck: Record<string, number>;
  readonly updated_at: string;
}

/**
 * One append-only batch of a checkpointed read. `threads` maps root IDs to their new thread, or to
 * `null` when the root left the working set. `seen` lists every root the read has applied.
 * `hosted` holds hosted-journal entries in checkpoints written by Atlas 6.2 and earlier, which
 * wrote one segment per hosted item. It is still read on resume and no longer written.
 */
export interface TeamsChannelCheckpointSegment {
  readonly threads: Record<string, TeamsThread | null>;
  readonly seen: string[];
  readonly hosted?: Record<string, TeamsHostedRef> | undefined;
}

/**
 * One hosted-journal entry: hosted content whose blob is being stored before its message is
 * recorded. `key` is `{root_id}/{reply_id}/{hosted_id}` (empty reply ID for a root). Each entry is
 * its own object beside the head, which never names it, so journaling an item writes one small
 * object and leaves the head alone. A resumed read reuses the blob instead of downloading it again.
 */
export interface TeamsChannelCheckpointHostedEntry {
  readonly key: string;
  readonly ref: TeamsHostedRef;
}
