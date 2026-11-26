/**
 * Issue #880. A cooldown is announced once, when it is raised, because every request parked on it
 * waits for the same end. The line names the pool or owner by id only, and reaches a host's sink.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { LogSink } from '@wisecom/atlas-types';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/outlook/connector.port';
import { logger } from '@wisecom/atlas-core/utils/logger';
import { run_with_log_scope } from '@wisecom/atlas-core/utils/log-context';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { RateLimitedGraphConnector } from '@/rate-limited-graph-connector.adapter';
import { with_graph_retry } from '@/graph-request-error-handler';
import { report_transfer_throttle } from '@/graph-transfer-throttle';
import { announce_cooldown } from '@/graph-wait-notice';

const MAILBOX = '0f8e1c2a-3b4d-4e5f-8a9b-1c2d3e4f5a6b';
const ADDRESS = 'john.doe@example.com';
const END = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';

let throttle: InProcessThrottleCoordinator;
let warn: MockInstance<(message: string) => void>;

function throttled(retry_after_seconds: string): Record<string, unknown> {
  return {
    statusCode: 429,
    code: 'ApplicationThrottled',
    message: 'Too Many Requests',
    headers: new Headers({ 'retry-after': retry_after_seconds }),
  };
}

/** A listing throttled once with `retry_after`, then answered. */
function throttled_once(retry_after: string) {
  return vi
    .fn<() => Promise<unknown[]>>()
    .mockRejectedValueOnce(throttled(retry_after))
    .mockResolvedValue([]);
}

function connector_listing_with(send: () => Promise<unknown[]>): RateLimitedGraphConnector {
  return new RateLimitedGraphConnector(
    { list_mail_folders: () => with_graph_retry(send) } as unknown as MailboxConnector,
    new DefaultMailboxRateLimiterFactory(),
    throttle,
  );
}

function wait_lines(): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('Waiting'));
}

beforeEach(() => {
  vi.useFakeTimers();
  throttle = new InProcessThrottleCoordinator();
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  throttle.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Graph cooldown notice (issue #880)', () => {
  it('announces a mailbox cooldown once, with its cause and end, for ten parked requests', async () => {
    const connector = connector_listing_with(throttled_once('600'));

    const first = connector.list_mail_folders('t', MAILBOX);
    await vi.advanceTimersByTimeAsync(1_000);
    const parked = Array.from({ length: 9 }, () => connector.list_mail_folders('t', MAILBOX));
    await vi.advanceTimersByTimeAsync(700_000);
    await Promise.all([first, ...parked]);

    expect(wait_lines()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Waiting 10 min, until ${END}, for the cooldown on mailbox ${MAILBOX} ` +
            'after HTTP 429 ApplicationThrottled with Retry-After 600 s$',
        ),
      ),
    ]);
    connector.shutdown();
  });

  it('does not name a mailbox known only by its address', async () => {
    const connector = connector_listing_with(throttled_once('600'));

    const listing = connector.list_mail_folders('t', ADDRESS);
    await vi.advanceTimersByTimeAsync(700_000);
    await listing;

    expect(wait_lines()).toEqual([
      expect.stringContaining('for the cooldown on the mailbox after'),
    ]);
    expect(wait_lines()[0]).not.toContain(ADDRESS);
    connector.shutdown();
  });

  it('names a Retry-After above the cap and the hour actually waited', async () => {
    const connector = connector_listing_with(throttled_once('4000'));

    const listing = connector.list_mail_folders('t', MAILBOX).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    await listing;

    expect(wait_lines()).toEqual([
      expect.stringMatching(/^Waiting 60 min, .*with Retry-After 4000 s, capped at 3600 s$/),
    ]);
    connector.shutdown();
  });

  it('announces a raise again only when it moves the end by more than a minute', async () => {
    const target = { coordinator: throttle, pool: 'outlook' as const, scope: { ownerId: MAILBOX } };

    announce_cooldown(target, 600_000, 'HTTP 429');
    await vi.advanceTimersByTimeAsync(10_000);
    announce_cooldown(target, 600_000, 'HTTP 429');
    expect(wait_lines()).toHaveLength(1);

    announce_cooldown(target, 3_600_000, 'HTTP 429');
    expect(wait_lines()).toHaveLength(2);
    expect(wait_lines()[1]).toMatch(/^Waiting 60 min, /);

    announce_cooldown({ ...target, scope: { ownerId: 'another-mailbox' } }, 600_000, 'HTTP 429');
    expect(wait_lines()).toHaveLength(3);
  });

  it('prints nothing for the 30 s cooldown of a 429 without Retry-After', async () => {
    const send = vi
      .fn<() => Promise<unknown[]>>()
      .mockRejectedValueOnce({ statusCode: 429, message: 'Too Many Requests' })
      .mockResolvedValue([]);
    const connector = connector_listing_with(send);

    const listing = connector.list_mail_folders('t', MAILBOX);
    await vi.advanceTimersByTimeAsync(60_000);
    await listing;

    expect(wait_lines()).toEqual([]);
    connector.shutdown();
  });

  it('announces a transfer cooldown once on the sharepoint_onedrive pool', () => {
    const response = new Response(null, { status: 429, headers: { 'Retry-After': '300' } });

    run_with_throttle_coordinator(throttle, 'sharepoint_onedrive', () => {
      report_transfer_throttle(response);
      report_transfer_throttle(response);
    });

    expect(wait_lines()).toEqual([
      expect.stringMatching(
        /^Waiting 5 min, until .*, for the cooldown on the sharepoint_onedrive pool after HTTP 429 with Retry-After 300 s$/,
      ),
    ]);
  });

  it("sends the line to an SDK host's log sink", async () => {
    warn.mockRestore();
    const sink: LogSink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const connector = connector_listing_with(throttled_once('600'));

    const listing = run_with_log_scope({ sink, fields: { tenant_id: 't' } }, () =>
      connector.list_mail_folders('t', MAILBOX),
    );
    await vi.advanceTimersByTimeAsync(700_000);
    await listing;

    expect(sink.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^Waiting 10 min, .*cooldown on mailbox/),
      { tenant_id: 't' },
    );
    connector.shutdown();
  });
});
