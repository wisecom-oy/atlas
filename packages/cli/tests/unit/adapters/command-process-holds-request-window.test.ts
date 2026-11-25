import { Container } from 'inversify';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { RateLimitedGraphConnector } from '@wisecom/atlas-m365-graph';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { DefaultMailboxRateLimiterFactory } from '@wisecom/atlas-core/services/shared/mailbox-rate-limiter';
import { MAILBOX_CONNECTOR_TOKEN } from '@wisecom/atlas-types';
import type { MailboxConnector } from '@wisecom/atlas-types/ports/outlook/connector.port';
import {
  release_command_process_holds,
  track_command_container,
} from '@/adapters/command-process-holds';

/**
 * Issue #859. A read parked on a mailbox's request window holds the process open while the command
 * runs. Once the command has ended, failed or not, that hold must go, or the process would sit out
 * the rest of the 10-minute window after printing its result.
 */
const TENANT = 'tenant-a';
const MAILBOX = 'mailbox-a';

interface FakeTimer {
  hasRef(): boolean;
}

let set_interval: MockInstance<typeof setInterval>;

/** Whether any request window's slide timer keeps the process alive. */
function holds_process(): boolean {
  return set_interval.mock.results.some((result) => (result.value as FakeTimer).hasRef());
}

/** A container whose mailbox connector is built on first use, as `bind_outlook` binds it. */
function container_with_mailbox_connector(build: () => MailboxConnector): Container {
  const container = new Container();
  container.bind(MAILBOX_CONNECTOR_TOKEN).toDynamicValue(build).inSingletonScope();
  return container;
}

/** A rate-limited connector over a one-token window, whose reads answer at once. */
function one_token_connector(): RateLimitedGraphConnector {
  const throttle = new InProcessThrottleCoordinator();
  const inner = { fetch_mime: async () => Buffer.from('mime') } as unknown as MailboxConnector;
  return new RateLimitedGraphConnector(
    inner,
    new DefaultMailboxRateLimiterFactory(throttle, 1),
    throttle,
  );
}

describe('request windows once a CLI command has ended', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    set_interval = vi.spyOn(globalThis, 'setInterval');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('holds the process while a read is parked, and lets go once the command ends', async () => {
    const container = track_command_container(
      container_with_mailbox_connector(one_token_connector),
    );
    const connector = container.get<RateLimitedGraphConnector>(MAILBOX_CONNECTOR_TOKEN);
    await connector.fetch_mime(TENANT, MAILBOX, 'm1');
    let parked_read_done = false;
    void connector.fetch_mime(TENANT, MAILBOX, 'm2').then(() => {
      parked_read_done = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(holds_process()).toBe(true);

    release_command_process_holds();

    expect(holds_process()).toBe(false);
    expect(parked_read_done).toBe(false);
    connector.shutdown();
  });

  it('does not build a mailbox connector the command never used', () => {
    const build = vi.fn(one_token_connector);
    track_command_container(container_with_mailbox_connector(build));

    release_command_process_holds();

    expect(build).not.toHaveBeenCalled();
  });

  it('ignores a container with no mailbox connector, or one that is not rate limited', () => {
    const plain = { fetch_mime: vi.fn() } as unknown as MailboxConnector;
    const container = track_command_container(container_with_mailbox_connector(() => plain));

    expect(container.get(MAILBOX_CONNECTOR_TOKEN)).toBe(plain);
    track_command_container(new Container());
    expect(() => release_command_process_holds()).not.toThrow();
  });
});
