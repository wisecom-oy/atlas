import { is_invalid_delta_error } from '@wisecom/atlas-m365-graph';
import { logger } from '@wisecom/atlas-core/utils/logger';
import type {
  TeamsGraphResource,
  TeamsMessageDeltaPage,
  TeamsMessageListPage,
  TeamsRootChange,
} from '@wisecom/atlas-types';
import type { BackupRunScope } from '@/services/backup/backup-run-scope';
import {
  apply_root_tasks,
  changed_tasks,
  drop_unlisted_root_tracking,
  fetched_task,
  pending_retry_roots,
} from '@/services/backup/channel-root-applier';
import { flush_channel_run, type ChannelRun } from '@/services/backup/channel-run-state';
import { graph_status_of } from '@/services/shared/graph-error-status';

/** Roots applied per page or retry batch. Graph returns 50 roots per page, one page per step. */
const ROOTS_PER_STEP = 50;

/**
 * Reads a channel's roots phase by phase until the read finishes or an interrupt stops it. Returns
 * true when interrupted. Each page is applied and checkpointed before the next page is requested.
 */
export async function read_channel_pages(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  run: ChannelRun,
): Promise<boolean> {
  while (run.phase !== 'done') {
    const interrupted =
      run.phase === 'delta'
        ? await read_delta_phase(scope, channel, run)
        : run.phase === 'list'
          ? await read_list_phase(scope, channel, run)
          : await read_retry_phase(scope, channel, run);
    if (interrupted) return true;
  }
  return false;
}

/** The page a phase reads next: the saved page, or the phase's first page. */
function page_url(run: ChannelRun): string | undefined {
  if (run.next_page !== undefined) return run.next_page;
  return run.phase === 'delta' && run.mode === 'delta' ? run.start_link : undefined;
}

/** Graph refused a page link: it expired, was removed, or is not a valid delta token. */
function is_link_rejection(err: unknown): boolean {
  const status = graph_status_of(err);
  return status === 400 || status === 404 || status === 410 || is_invalid_delta_error(err);
}

/** A delta page and the link it was read from, or a rejected delta the read moved on from. */
type DeltaFetch =
  { readonly page: TeamsMessageDeltaPage; readonly url: string | undefined } | 'fell_back';

/**
 * Pages the delta feed. A delta read with a stored link that Graph rejects falls back to a full
 * read; a full read whose link-less delta is rejected goes straight to the listing.
 */
async function read_delta_phase(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  run: ChannelRun,
): Promise<boolean> {
  for (;;) {
    if (scope.should_interrupt()) return true;
    const fetched = await fetch_delta_page(scope, channel, run);
    if (fetched === 'fell_back') return false;
    const { page, url } = fetched;
    const interrupted = await apply_page(scope, channel.id, run, page.roots, url, () => {
      run.next_page = page.next_link;
      if (page.delta_link !== undefined) run.pending_delta_link = page.delta_link;
      if (page.next_link === undefined) run.phase = run.mode === 'delta' ? 'retry' : 'list';
    });
    if (interrupted) return true;
    if (run.phase !== 'delta') return false;
  }
}

/**
 * Reads the next delta page. A rejected saved page restarts the phase from its first page; a
 * rejected first page moves the read on (see `fall_back_from_delta`).
 */
async function fetch_delta_page(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  run: ChannelRun,
): Promise<DeltaFetch> {
  for (;;) {
    const url = page_url(run);
    try {
      const page = await scope.connector.fetch_message_delta_page(
        scope.tenant_id,
        scope.team_id,
        channel.id,
        url,
      );
      return { page, url };
    } catch (err) {
      if (!is_link_rejection(err)) throw err;
      if (run.next_page === undefined) {
        fall_back_from_delta(run, channel.id);
        return 'fell_back';
      }
      logger.warn(`Teams channel ${channel.id}: saved delta page rejected, restarting the phase`);
      run.next_page = undefined;
    }
  }
}

/**
 * Moves a rejected delta phase on. A delta read with a stored link becomes a full read; a full read
 * stores no link and lists the roots instead.
 */
function fall_back_from_delta(run: ChannelRun, channel_id: string): void {
  run.next_page = undefined;
  run.pending_delta_link = undefined;
  if (run.mode === 'delta') {
    logger.warn(`Teams channel ${channel_id}: delta rejected, reading every root in full`);
    run.mode = 'full';
    return;
  }
  logger.warn(`Teams channel ${channel_id}: delta without a link rejected, no link stored`);
  run.phase = 'list';
}

/**
 * Applies one page's roots and checkpoints them. On an interrupt the checkpoint keeps the page's own
 * link, so the next run reads this page again; otherwise `advance` moves the run past it first.
 * Returns true when interrupted.
 */
async function apply_page(
  scope: BackupRunScope,
  channel_id: string,
  run: ChannelRun,
  roots: TeamsRootChange[],
  url: string | undefined,
  advance: () => void,
): Promise<boolean> {
  const batch = await apply_root_tasks(scope, channel_id, changed_tasks(roots), run.state);
  if (batch.interrupted) run.next_page = url;
  else advance();
  await flush_channel_run(scope, run, { threads: batch.processed, seen: batch.processed });
  scope.progress.roots_applied(channel_id, batch.processed.length);
  return batch.interrupted;
}

/**
 * Pages `/messages` for a full read, skipping roots the delta phase already applied. The last page
 * also sweeps the roots the read did not list and finishes the read.
 */
async function read_list_phase(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  run: ChannelRun,
): Promise<boolean> {
  for (;;) {
    if (scope.should_interrupt()) return true;
    const { page, url } = await fetch_list_page(scope, channel, run);
    const fresh = page.roots.filter((change) => !run.seen.has(change.root.id));
    if (page.next_link === undefined) return finish_list_phase(scope, channel.id, run, fresh, url);
    const interrupted = await apply_page(scope, channel.id, run, fresh, url, () => {
      run.next_page = page.next_link;
    });
    if (interrupted) return true;
  }
}

/** Reads the next listing page. A rejected saved page restarts the listing from its first page. */
async function fetch_list_page(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  run: ChannelRun,
): Promise<{ readonly page: TeamsMessageListPage; readonly url: string | undefined }> {
  for (;;) {
    const url = page_url(run);
    try {
      const page = await scope.connector.list_channel_messages_page(
        scope.tenant_id,
        scope.team_id,
        channel.id,
        url,
      );
      return { page, url };
    } catch (err) {
      if (run.next_page === undefined || !is_link_rejection(err)) throw err;
      logger.warn(`Teams channel ${channel.id}: saved listing page rejected, restarting it`);
      run.next_page = undefined;
    }
  }
}

/**
 * Applies the last listing page and ends the listing. Roots the listing did not show leave the
 * ledger and recheck, and one flush saves the page with that change, so a crash before it replays
 * only this page. A live root the listing missed is not marked removed here: a root can fall between
 * two pages when the channel changes during paging, so the retry step reads each one by id and only
 * a 404 marks it removed. An interrupt keeps the page's link, because the drop needs every root seen.
 */
async function finish_list_phase(
  scope: BackupRunScope,
  channel_id: string,
  run: ChannelRun,
  roots: TeamsRootChange[],
  url: string | undefined,
): Promise<boolean> {
  const batch = await apply_root_tasks(scope, channel_id, changed_tasks(roots), run.state);
  if (batch.interrupted) {
    run.next_page = url;
    await flush_channel_run(scope, run, { threads: batch.processed, seen: batch.processed });
    scope.progress.roots_applied(channel_id, batch.processed.length);
    return true;
  }
  for (const id of batch.processed) run.seen.add(id);
  drop_unlisted_root_tracking(run.state, run.seen);
  const owed = pending_retry_roots(run.state, channel_id, run.seen, true).length > 0;
  run.phase = owed ? 'retry' : 'done';
  run.next_page = undefined;
  scope.progress.roots_applied(channel_id, batch.processed.length);
  await flush_channel_run(scope, run, { threads: batch.processed, seen: batch.processed });
  return false;
}

/**
 * Re-applies ledger roots and hosted rechecks that the read did not see, and after a full read
 * confirms the live roots its listing missed. Batches are recomputed from the current state each
 * time, so a root applied in an earlier batch is not picked again.
 */
async function read_retry_phase(
  scope: BackupRunScope,
  channel: TeamsGraphResource,
  run: ChannelRun,
): Promise<boolean> {
  const full_read = run.mode === 'full';
  for (;;) {
    if (scope.should_interrupt()) return true;
    const pending = pending_retry_roots(run.state, channel.id, run.seen, full_read).slice(
      0,
      ROOTS_PER_STEP,
    );
    if (pending.length === 0) {
      run.phase = 'done';
      await flush_channel_run(scope, run, { threads: [], seen: [] });
      return false;
    }
    const tasks = pending.map((root) => fetched_task(scope, channel.id, root.root_id, root.reason));
    const batch = await apply_root_tasks(scope, channel.id, tasks, run.state);
    await flush_channel_run(scope, run, { threads: batch.processed, seen: batch.processed });
    scope.progress.roots_applied(channel.id, batch.processed.length);
    if (batch.interrupted) return true;
  }
}
