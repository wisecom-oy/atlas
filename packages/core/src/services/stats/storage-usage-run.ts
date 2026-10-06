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
 * that stops at any page boundary resumes exactly where its counts end. That holds for a failed
 * request too: the page it was fetching is not counted, its cursor has not moved, and the error is
 * thrown with `state` at the last boundary.
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
    await size_incomplete_uploads(state, inventory, should_stop);
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

/**
 * Lists the queued prefixes in parallel; a prefix leaves the queue once its last page is in.
 *
 * The first failed request stops every worker before its next page, so nothing keeps listing for
 * a run that is already lost, and the failure is rethrown once the pages in flight have settled.
 */
async function list_prefixes(
  state: UsageState,
  inventory: StorageInventory,
  should_stop: (in_flight?: number) => boolean,
): Promise<void> {
  const queue = [...state.prefixes];
  const finished = new Set<PendingPrefix>();
  let failure: { error: unknown } | undefined;
  let in_flight = 0;
  const stop = (): boolean => failure !== undefined || should_stop(in_flight);

  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry && !stop(); entry = queue.shift()) {
      const pending = entry;
      while (!stop()) {
        in_flight++;
        let page: StorageObjectPage;
        try {
          page = await inventory.list_object_page({
            prefix: pending.prefix,
            mode: pending.mode ?? state.mode,
            cursor: pending.cursor,
          });
        } catch (error) {
          failure ??= { error };
          return;
        } finally {
          in_flight--;
        }
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
  if (failure) throw failure.error;
}

/**
 * Lists incomplete uploads and sizes each from its parts, one request per step: a page of uploads
 * can hold a hundred, and sizing them all at once would run far past a request allowance.
 */
async function size_incomplete_uploads(
  state: UsageState,
  inventory: StorageInventory,
  should_stop: () => boolean,
): Promise<void> {
  const uploads = state.uploads;
  while (!(uploads.listed && uploads.pending.length === 0) && !should_stop()) {
    if (uploads.pending.length === 0) await list_next_upload_page(state, inventory);
    else await size_next_upload(state, inventory);
  }
}

/** Queues one page of uploads for sizing, or counts them unsized once parts were refused. */
async function list_next_upload_page(
  state: UsageState,
  inventory: StorageInventory,
): Promise<void> {
  const uploads = state.uploads;
  const page = await inventory.list_incomplete_upload_page(uploads.cursor);
  state.requests++;
  if (!page.visible) uploads.visible = false;
  for (const upload of page.uploads) {
    // Without part access the upload still counts; only its bytes are unknown.
    if (uploads.parts_denied) tally_upload(state, upload.key, 0);
    else uploads.pending.push({ ...upload, bytes: 0 });
  }
  uploads.cursor = page.next;
  uploads.listed = page.next === undefined;
}

/** Reads one page of the first queued upload's parts, counting the upload once it is sized. */
async function size_next_upload(state: UsageState, inventory: StorageInventory): Promise<void> {
  const uploads = state.uploads;
  const [current] = uploads.pending;
  if (!current) return;
  const parts = await inventory.list_upload_parts_page(current, current.part_marker);
  state.requests++;

  if (parts.status === 'denied') {
    // The figure is incomplete from here on: say so, and keep counting what can be counted.
    uploads.visible = false;
    uploads.parts_denied = true;
    for (const upload of uploads.pending.splice(0)) tally_upload(state, upload.key, upload.bytes);
    return;
  }
  if (parts.status === 'gone') {
    // Completed or aborted since it was listed: it holds no parts any more.
    uploads.pending.shift();
    return;
  }
  current.bytes += parts.bytes;
  current.part_marker = parts.next_part_marker;
  if (parts.next_part_marker === undefined) {
    tally_upload(state, current.key, current.bytes);
    uploads.pending.shift();
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
