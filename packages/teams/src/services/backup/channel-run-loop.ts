import { setMaxListeners } from 'node:events';
import { retryable_items } from '@wisecom/atlas-core/services/shared/failed-item-ledger';
import { run_with_abort_signal } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { emit_operation_progress } from '@wisecom/atlas-core/services/shared/operation-progress';
import { logger } from '@wisecom/atlas-core/utils/logger';
import {
  AuthError,
  UnreadableContentError,
  UnsupportedFormatVersionError,
  type TeamsBackupOptions,
  type TeamsChannelRunOutcome,
  type TeamsChannelShard,
  type TeamsChannelShardRepository,
  type TeamsGraphResource,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  backup_channel,
  type ChannelBackupOutput,
  type ChannelStartState,
} from '@/services/backup/channel-backup-processor';
import type { TeamsBaseline } from '@/services/backup/team-baseline-loader';
import { error_message } from '@/services/shared/error-message';
import { append_all } from '@wisecom/atlas-core/utils/append-all';

/** How one started channel ended. Channels the run never started have no record. */
export interface ChannelRunRecord {
  readonly outcome: TeamsChannelRunOutcome;
  readonly read_mode: 'full' | 'delta' | undefined;
  readonly resumed_from_checkpoint: boolean;
  readonly elapsed_ms: number;
  readonly output: ChannelBackupOutput | undefined;
  readonly errors: string[];
  readonly warnings: string[];
}

/** What the channel loop produced: outputs for channels it attempted, plus run flags. */
export interface ChannelRunState {
  readonly results: Map<string, ChannelBackupOutput>;
  readonly records: Map<string, ChannelRunRecord>;
  readonly errors: string[];
  readonly warnings: string[];
  attempted: number;
  interrupted: boolean;
}

/** Read-only inputs for the channel loop: the loaded baseline, the shard store, and run options. */
export interface ChannelRunInputs {
  readonly baseline: TeamsBaseline;
  readonly shards: TeamsChannelShardRepository;
  readonly options: TeamsBackupOptions;
  /** Channels backed up at once. Already validated by `resolve_channel_concurrency`. */
  readonly concurrency: number;
}

/** One pool run's shared state: queue cursor, first fatal error, and progress count. */
interface PoolRun {
  readonly scope: BackupRunScope;
  readonly selected: TeamsGraphResource[];
  readonly state: ChannelRunState;
  readonly inputs: ChannelRunInputs;
  readonly controller: AbortController;
  readonly started_at: number;
  next: number;
  finished: number;
  fatal: { readonly error: unknown } | undefined;
}

/** The channels the run covers: all listed channels, or only the one `channel_id` names. */
export function select_channels(
  channels: TeamsGraphResource[],
  channel_id: string | undefined,
): TeamsGraphResource[] {
  return channels.filter((channel) => channel_id === undefined || channel.id === channel_id);
}

/**
 * Backs up the selected channels with up to `concurrency` in flight. Workers stop taking channels
 * on interrupt. An authentication failure or a shard written by a newer format aborts the other
 * channels, waits for them to settle, and is rethrown. A channel that fails is recorded and the
 * others still run. Results, errors and warnings are reported in listing order, not finish order.
 */
export async function process_channels(
  scope: BackupRunScope,
  channels: TeamsGraphResource[],
  inputs: ChannelRunInputs,
): Promise<ChannelRunState> {
  const selected = select_channels(channels, inputs.options.channel_id);
  const state: ChannelRunState = {
    results: new Map(),
    records: new Map(),
    errors: [],
    warnings: [],
    attempted: 0,
    interrupted: false,
  };
  const controller = new AbortController();
  // ponytail: unbounded listener count on the pool signal (one per in-flight request).
  // Cap it if a leak shows.
  setMaxListeners(0, controller.signal);
  const unlink = link_pool_signal(inputs.options.abort_signal, controller);
  const pool_scope: BackupRunScope = {
    ...scope,
    should_interrupt: () => scope.should_interrupt() || controller.signal.aborted,
  };
  const run: PoolRun = {
    scope: pool_scope,
    selected,
    state,
    inputs,
    controller,
    started_at: Date.now(),
    next: 0,
    finished: 0,
    fatal: undefined,
  };
  try {
    const workers = Array.from({ length: Math.min(inputs.concurrency, selected.length) }, () =>
      pool_worker(run),
    );
    await Promise.allSettled(workers);
  } finally {
    unlink();
  }
  if (run.fatal !== undefined) throw run.fatal.error;
  assemble_run_state(selected, state);
  return state;
}

/** Aborts the pool when the run's own signal aborts. Returns the function that removes the link. */
function link_pool_signal(
  parent: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (parent === undefined) return () => undefined;
  const forward = () => controller.abort(parent.reason);
  if (parent.aborted) forward();
  parent.addEventListener('abort', forward, { once: true });
  return () => parent.removeEventListener('abort', forward);
}

/** One worker: takes the next channel off the queue until the queue, the run, or the pool ends. */
async function pool_worker(run: PoolRun): Promise<void> {
  while (run.fatal === undefined && !run.state.interrupted && run.next < run.selected.length) {
    if (run.scope.should_interrupt()) {
      run.state.interrupted = true;
      return;
    }
    const channel = run.selected[run.next++];
    if (channel === undefined) return;
    run.state.attempted++;
    try {
      await run_with_abort_signal(run.controller.signal, () =>
        run_channel(run.scope, channel, run.state, run.inputs),
      );
    } catch (err) {
      record_fatal(run, err);
      return;
    }
    if (run.state.records.get(channel.id)?.outcome === 'interrupted') run.state.interrupted = true;
    report_channel_finished(run, channel);
  }
}

/** Keeps the first fatal error and aborts the siblings so they stop at their next request. */
function record_fatal(run: PoolRun, err: unknown): void {
  if (run.fatal === undefined) run.fatal = { error: err };
  run.controller.abort(err);
}

/** Emits one `processing` event: channels finished, selected, and the estimated time left. */
function report_channel_finished(run: PoolRun, channel: TeamsGraphResource): void {
  run.finished++;
  const total = run.selected.length;
  const elapsed = Date.now() - run.started_at;
  emit_operation_progress(run.inputs.options, {
    operation: 'backup',
    workload: 'teams',
    phase: 'processing',
    processed: run.finished,
    total,
    current: channel.displayName ?? channel.id,
    eta_ms: Math.round((elapsed / run.finished) * (total - run.finished)),
  });
}

/** Copies records into the state in listing order, so output does not depend on finish order. */
function assemble_run_state(selected: TeamsGraphResource[], state: ChannelRunState): void {
  for (const channel of selected) {
    const record = state.records.get(channel.id);
    if (record === undefined) continue;
    if (record.output !== undefined) state.results.set(channel.id, record.output);
    append_all(state.errors, record.errors);
    append_all(state.warnings, record.warnings);
  }
}

/** Backs up one channel and records how it ended. Fatal errors propagate, others become records. */
async function run_channel(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  state: ChannelRunState,
  inputs: ChannelRunInputs,
): Promise<void> {
  const started = Date.now();
  try {
    const start_warnings: string[] = [];
    const start = await channel_start_state(scope, channel.id, inputs, start_warnings);
    const output = await backup_channel(scope, channel, start);
    state.records.set(channel.id, {
      outcome: channel_outcome(output, channel.id),
      read_mode: output.shard.read_mode,
      resumed_from_checkpoint: output.resumed_from_checkpoint,
      elapsed_ms: Date.now() - started,
      output,
      errors: output.errors,
      warnings: [...start_warnings, ...output.warnings],
    });
  } catch (err) {
    if (err instanceof AuthError || err instanceof UnsupportedFormatVersionError) throw err;
    if (scope.should_interrupt()) {
      state.records.set(channel.id, unfinished_record('interrupted', started, []));
      return;
    }
    const message = error_message(err);
    logger.warn(`Teams channel ${channel.id} backup failed: ${message}`);
    state.records.set(
      channel.id,
      unfinished_record('failed', started, [`Channel ${channel.id}: ${message}`]),
    );
  }
}

/** Outcome of a channel that finished without throwing. */
function channel_outcome(output: ChannelBackupOutput, channel_id: string): TeamsChannelRunOutcome {
  if (output.interrupted) return 'interrupted';
  return retryable_items(output.failed_roots, channel_id).length > 0 ? 'incomplete' : 'completed';
}

/** Record for a channel that threw or stopped before producing an output. */
function unfinished_record(
  outcome: TeamsChannelRunOutcome,
  started: number,
  errors: string[],
): ChannelRunRecord {
  return {
    outcome,
    read_mode: undefined,
    resumed_from_checkpoint: false,
    elapsed_ms: Date.now() - started,
    output: undefined,
    errors,
    warnings: [],
  };
}

/**
 * Loads the channel's previous shard, so unchanged content and the cursor can be compared. Under
 * `--full`, a damaged or missing previous shard gives the start state of a channel that has none:
 * no entry, no shard and no delta link, so the channel is rebuilt from Graph, its checkpoint no
 * longer matches, and a new shard is saved (issue #708).
 */
async function channel_start_state(
  scope: BackupRunScope,
  channel_id: string,
  inputs: ChannelRunInputs,
  warnings: string[],
): Promise<ChannelStartState> {
  const base = inputs.baseline.channels.get(channel_id);
  const tracking = {
    failed_roots: base?.failed_roots ?? {},
    hosted_recheck: base?.hosted_recheck ?? {},
  };
  const previous_entry = base?.previous_entry;
  if (previous_entry === undefined) {
    return {
      previous_entry,
      previous_shard: undefined,
      stored_link: base?.delta_link,
      ...tracking,
    };
  }
  const previous_shard = await load_shard_unless_rebuilding(
    scope,
    inputs.shards,
    channel_id,
    previous_entry.shard_key,
    warnings,
  );
  if (previous_shard === undefined) {
    return {
      previous_entry: undefined,
      previous_shard: undefined,
      stored_link: undefined,
      unreadable_shard_key: previous_entry.shard_key,
      ...tracking,
    };
  }
  return { previous_entry, previous_shard, stored_link: base?.delta_link, ...tracking };
}

/**
 * Loads one shard. A damaged or missing shard fails the channel with the command that rebuilds it,
 * or under `--full` warns and returns undefined so the run rebuilds it. A shard written by a newer
 * Atlas format and a storage failure throw unchanged in both cases.
 */
async function load_shard_unless_rebuilding(
  scope: BackupRunScope,
  shards: TeamsChannelShardRepository,
  channel_id: string,
  shard_key: string,
  warnings: string[],
): Promise<TeamsChannelShard | undefined> {
  try {
    return await shards.load(scope.ctx, shard_key);
  } catch (err) {
    if (!(err instanceof UnreadableContentError)) throw err;
    if (!scope.force_full) {
      throw new UnreadableContentError(
        `${err.message}. Rebuild the channel from Graph with: atlas teams backup ` +
          `--team ${scope.team_id} --channel ${channel_id} --full`,
        { cause: err },
      );
    }
    const warning =
      `Channel ${channel_id}: its previous shard ${shard_key} could not be read ` +
      `(${err.message}); rebuilding the channel from Graph without it. Threads that shard held ` +
      `and Teams no longer returns are not in the new shard`;
    logger.warn(warning);
    warnings.push(warning);
    return undefined;
  }
}
