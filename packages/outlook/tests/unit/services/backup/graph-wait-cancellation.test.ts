/**
 * Issue #673: the Outlook backup had no abort signal at all, so Ctrl+C during a delta page or a
 * MIME read parked in a Graph Retry-After sat the wait out, and the folder that held it was then
 * reported as failed.
 */

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxConnector, MailMessage } from '@wisecom/atlas-types';
import { with_graph_retry } from '@wisecom/atlas-m365-graph';
import {
  create_mailbox_sync_harness,
  make_delta,
  make_message,
  type MailboxSyncHarness,
} from './mailbox-sync.fixtures';

/** A Graph call throttled with `Retry-After: 360`, which on its own waits six minutes. */
function graph_call_parked_in_retry_wait(): Promise<never> {
  return with_graph_retry(() =>
    Promise.reject({
      statusCode: 429,
      message: 'Too Many Requests',
      headers: new Headers({ 'retry-after': '360' }),
    }),
  );
}

/** Starts a backup, cancels it 5 s in, and reports whether it settled within a second. */
async function cancel_after_five_seconds(h: MailboxSyncHarness) {
  const controller = new AbortController();
  let settled = false;
  const run = h.service
    .sync_mailbox('tenant-1', 'owner-1', { abort_signal: controller.signal })
    .finally(() => (settled = true));
  await vi.advanceTimersByTimeAsync(5_000);
  const settled_before_cancel = settled;

  controller.abort(new Error('Run interrupted by Ctrl+C'));
  await vi.advanceTimersByTimeAsync(1_000);

  return { settled_before_cancel, settled_within_a_second: settled, result: await run };
}

describe('Outlook backup cancelled during a Graph retry wait (issue #673)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ends a delta page wait within a second and records an interrupted run, not a failed folder', async () => {
    const h = create_mailbox_sync_harness();
    vi.mocked(h.mock_connector.fetch_delta).mockImplementation(graph_call_parked_in_retry_wait);

    const outcome = await cancel_after_five_seconds(h);

    expect(outcome.settled_before_cancel).toBe(false);
    expect(outcome.settled_within_a_second).toBe(true);
    expect(outcome.result.interrupted).toBe(true);
    expect(outcome.result.summary.folder_errors).toEqual([]);
    expect(outcome.result.summary.completed_folder_count).toBe(0);
    expect(outcome.result.manifest.delta_links).not.toHaveProperty('folder-1');
  });

  it('ends a MIME read wait without recording the message as captured from JSON', async () => {
    const h = create_mailbox_sync_harness();
    const page: MailMessage[] = [make_message('m1', 'body')];
    const connector = h.mock_connector as MailboxConnector & { fetch_mime: unknown };
    connector.fetch_mime = vi.fn(graph_call_parked_in_retry_wait);
    vi.mocked(h.mock_connector.fetch_delta).mockImplementation(
      async (_tenant, _owner, _folder, _link, on_page) => {
        await on_page?.(1, page.length, page);
        return make_delta([], 'new-link');
      },
    );

    const outcome = await cancel_after_five_seconds(h);

    expect(outcome.settled_within_a_second).toBe(true);
    expect(outcome.result.interrupted).toBe(true);
    expect(outcome.result.summary.folder_errors).toEqual([]);
    expect(outcome.result.summary.completed_folder_count).toBe(0);
  });
});
