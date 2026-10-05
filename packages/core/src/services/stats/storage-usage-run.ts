import type { StorageInventory, StorageObjectPage } from '@wisecom/atlas-types';
import type { PendingPrefix, UsageState } from '@/services/stats/storage-usage-state';
import { tally_object, tally_upload } from '@/services/stats/storage-usage-tally';

/**
 * Top-level prefixes listed at once. The layout has a handful (`data/`, `onedrive/`, ...), and
 * one listing per prefix keeps request ordering simple to resume.
 * ponytail: parallelism is per top-level prefix, so one huge prefix lists serially; split by the
 * second segment if a single workload dominates wall time.
 */
const PREFIX_CONCURRENCY = 4;

export interface RunLimits {
  /** Requests this call may make; a resumed call gets its own allowance. */
  readonly max_requests?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Advances `state` page by page until every phase is done or a limit stops it.
 *
 * Counts are added only after a whole page was listed, and the cursor moves with them, so a run
 * that stops at any page boundary resumes exactly where its counts end.
 */
export async function run_usage_listing(
  state: UsageState,
  inventory: StorageInventory,
  limits: RunLimits,
): Promise<void> {
  const allowance_ends_at =
    limits.max_requests === undefined ? undefined : state.requests + limits.max_requests;
  // Pages already in flight count against the allowance, or parallel prefixes would each start
  // one past it.
  const should_stop = (in_flight = 0): boolean =>
    limits.signal?.aborted === true ||
    (allowance_ends_at !== undefined && state.requests + in_flight >= allowance_ends_at);

  await discover_prefixes(state, inventory, should_stop);
  if (state.discovery.done) await list_prefixes(state, inventory, should_stop);
  if (state.discovery.done && state.prefixes.length === 0) {
    await list_incomplete_uploads(state, inventory, should_stop);
  }
}

/** Lists the bucket root with a delimiter: root-level keys are counted, prefixes queued. */
async function discover_prefixes(
  state: UsageState,
  inventory: StorageInventory,
  should_stop: () => boolean,
): Promise<void> {
  while (!state.discovery.done && !should_stop()) {
    const page = await inventory.list_object_page({
      prefix: '',
      delimiter: '/',
      mode: state.mode,
      cursor: state.discovery.cursor,
    });
    absorb_page(state, page);
    for (const prefix of page.common_prefixes) state.prefixes.push({ prefix });
    state.discovery = page.next ? { done: false, cursor: page.next } : { done: true };
  }
}

/** Lists the queued prefixes in parallel; a prefix leaves the queue once its last page is in. */
async function list_prefixes(
  state: UsageState,
  inventory: StorageInventory,
  should_stop: (in_flight?: number) => boolean,
): Promise<void> {
  const queue = [...state.prefixes];
  const finished = new Set<PendingPrefix>();

  let in_flight = 0;
  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry && !should_stop(in_flight); entry = queue.shift()) {
      const pending = entry;
      while (!should_stop(in_flight)) {
        in_flight++;
        const page = await inventory
          .list_object_page({
            prefix: pending.prefix,
            mode: pending.mode ?? state.mode,
            cursor: pending.cursor,
          })
          .finally(() => in_flight--);
        absorb_page(state, page);
        pending.mode = page.mode;
        if (!page.next) {
          finished.add(pending);
          break;
        }
        pending.cursor = page.next;
      }
    }
  };
  await Promise.all(Array.from({ length: PREFIX_CONCURRENCY }, worker));

  state.prefixes = state.prefixes.filter((entry) => !finished.has(entry));
}

async function list_incomplete_uploads(
  state: UsageState,
  inventory: StorageInventory,
  should_stop: () => boolean,
): Promise<void> {
  while (!state.uploads.done && !should_stop()) {
    const page = await inventory.list_incomplete_upload_page(state.uploads.cursor);
    state.requests += page.requests;
    for (const upload of page.uploads) tally_upload(state, upload);
    state.uploads = page.next
      ? { done: false, visible: page.visible, cursor: page.next }
      : { done: true, visible: page.visible };
  }
}

/**
 * Counts a page and records which listing produced it. A refused version listing falls back to
 * live objects for the rest of the run, so every prefix that has not started begins in `current`
 * mode; one already listing keeps the mode its cursor belongs to.
 */
function absorb_page(state: UsageState, page: StorageObjectPage): void {
  state.requests += page.requests;
  if (page.mode === 'current' && state.mode === 'versions') {
    state.mode = 'current';
    state.versions_visible = false;
  }
  for (const object of page.objects) tally_object(state, object);
}
