/**
 * Issue #874: a MIME read parked on its mailbox's cooldown before it was sent ignored Ctrl+C and the
 * SDK's `abort_signal`, so the soft stop sat out up to an hour and the lease was left behind when
 * the operator pressed Ctrl+C again. The read now goes through the real rate-limited connector.
 */

import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailboxConnector, MailMessage } from '@wisecom/atlas-types';
import { RateLimitedGraphConnector } from '@wisecom/atlas-m365-graph';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import {
  create_mailbox_sync_harness,
  make_delta,
  make_message,
  type MailboxSyncHarness,
} from './mailbox-sync.fixtures';

const OWNER = 'owner-1';
const HOUR_MS = 3_600_000;

let throttle: InProcessThrottleCoordinator;
let limited: RateLimitedGraphConnector;
let send_mime: ReturnType<typeof vi.fn<() => Promise<Buffer>>>;

/** Two folders: the first finishes, the second holds a message whose MIME read meets a cooldown. */
function harness_with_mime_parked_on_cooldown(): MailboxSyncHarness {
  const h = create_mailbox_sync_harness();
  vi.mocked(h.mock_connector.list_mail_folders).mockResolvedValue([
    { folder_id: 'folder-1', display_name: 'Inbox', folder_path: 'Inbox', total_item_count: 0 },
    { folder_id: 'folder-2', display_name: 'Archive', folder_path: 'Archive', total_item_count: 1 },
  ]);
  const page: MailMessage[] = [make_message('m1', 'body')];
  vi.mocked(h.mock_connector.fetch_delta).mockImplementation(
    async (_tenant, _owner, folder_id, _link, on_page) => {
      if (folder_id === 'folder-1') return make_delta([], 'link-1');
      // The mailbox was throttled for an hour just before this folder's first MIME read.
      throttle.raise('outlook', HOUR_MS, { ownerId: OWNER });
      await on_page?.(1, page.length, page);
      return make_delta([], 'link-2');
    },
  );
  limited = new RateLimitedGraphConnector(
    { fetch_mime: send_mime } as unknown as MailboxConnector,
    new DefaultMailboxRateLimiterFactory(),
    throttle,
  );
  const connector = h.mock_connector as MailboxConnector & { fetch_mime: unknown };
  connector.fetch_mime = (tenant: string, owner: string, message_id: string) =>
    limited.fetch_mime(tenant, owner, message_id);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
  throttle = new InProcessThrottleCoordinator();
  send_mime = vi.fn(() => Promise.resolve(Buffer.from('mime')));
});

afterEach(() => {
  limited.shutdown();
  throttle.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Outlook backup cancelled while a read waits for the mailbox cooldown (issue #874)', () => {
  it('ends within a second, commits the finished folder and releases the lease', async () => {
    const h = harness_with_mime_parked_on_cooldown();
    const controller = new AbortController();
    let settled = false;
    const run = h.service
      .sync_mailbox('tenant-1', OWNER, { abort_signal: controller.signal })
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);

    controller.abort(new Error('Run interrupted by Ctrl+C'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const result = await run;
    expect(result.interrupted).toBe(true);
    expect(result.summary.folder_errors).toEqual([]);
    expect(result.manifest.delta_links).toHaveProperty('folder-1', 'link-1');
    expect(result.manifest.delta_links).not.toHaveProperty('folder-2');
    expect(h.mock_manifests.save).toHaveBeenCalled();
    expect(h.leases.held()).toBe(0);
    expect(send_mime).not.toHaveBeenCalled();
  });

  it('waits the cooldown out and sends the read when nothing cancels the run', async () => {
    const h = harness_with_mime_parked_on_cooldown();

    const run = h.service.sync_mailbox('tenant-1', OWNER, {});
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1_000);
    expect(send_mime).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await run;
    expect(send_mime).toHaveBeenCalledOnce();
    expect(result.interrupted).toBe(false);
  });
});
