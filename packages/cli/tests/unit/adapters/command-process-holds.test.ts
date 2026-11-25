import { Container } from 'inversify';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import {
  THROTTLE_COORDINATOR_TOKEN,
  ThrottledError,
  type ThrottleCoordinator,
} from '@wisecom/atlas-types';
import {
  release_command_process_holds,
  track_command_container,
} from '@/adapters/command-process-holds';
import { release_throttle_process_hold } from '@/adapters/throttle-cooldown-release';

/**
 * Issue #873. A command that failed on a Retry-After above the 1-hour cap left the cooldown its 429
 * raised armed, and the fence timer kept the CLI alive for up to an hour after the error was
 * printed. Once the command has ended, the cooldown must no longer hold the process, whatever the
 * outcome, while it still holds the process during the run.
 */
const ONE_HOUR_MS = 3_600_000;
const POOL = 'sharepoint_onedrive';

interface FakeTimer {
  hasRef(): boolean;
}

let set_timeout: MockInstance<typeof setTimeout>;

/** Whether any timer created so far still keeps the process alive. */
function holds_process(): boolean {
  return set_timeout.mock.results.some((result) => (result.value as FakeTimer).hasRef());
}

/** A container whose coordinator is cleared on unbind, as `bind_graph_client` binds it. */
function container_with(coordinator: InProcessThrottleCoordinator): Container {
  const container = new Container();
  container
    .bind(THROTTLE_COORDINATOR_TOKEN)
    .toConstantValue(coordinator)
    .onDeactivation(() => coordinator.clear());
  return container;
}

/** What `with_graph_retry` does with a 429 above the cap: raise the cooldown, then fail the call. */
function refuse_retry_after_above_cap(coordinator: InProcessThrottleCoordinator): Promise<never> {
  coordinator.raise(POOL, ONE_HOUR_MS);
  return Promise.reject(new ThrottledError('Graph asked to wait 3700 s', 3_700_000));
}

describe('throttle cooldowns once a CLI command has ended', () => {
  let coordinator: InProcessThrottleCoordinator;

  beforeEach(() => {
    vi.useFakeTimers();
    set_timeout = vi.spyOn(globalThis, 'setTimeout');
    coordinator = new InProcessThrottleCoordinator();
  });

  afterEach(() => {
    coordinator.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('holds the process while the command is still running', () => {
    track_command_container(container_with(coordinator));

    coordinator.raise(POOL, ONE_HOUR_MS);

    expect(holds_process()).toBe(true);
  });

  it('lets a command that failed on a Retry-After above the cap exit, with the cooldown still armed', async () => {
    track_command_container(container_with(coordinator));

    await expect(refuse_retry_after_above_cap(coordinator)).rejects.toBeInstanceOf(ThrottledError);
    release_command_process_holds();

    expect(holds_process()).toBe(false);
    expect(coordinator.is_cooling(POOL)).toBe(true);
  });

  it('keeps a caller parked on the cooldown parked rather than sending it early', async () => {
    track_command_container(container_with(coordinator));
    coordinator.raise('outlook', ONE_HOUR_MS, { ownerId: 'mailbox-a' });
    let released = false;
    void coordinator.wait('outlook', { ownerId: 'mailbox-a' }).then(() => {
      released = true;
    });

    release_command_process_holds();
    await vi.advanceTimersByTimeAsync(ONE_HOUR_MS - 1);

    expect(holds_process()).toBe(false);
    expect(released).toBe(false);
  });

  it('releases every tracked container, such as the target of a cross-tenant restore', () => {
    const target = new InProcessThrottleCoordinator();
    track_command_container(container_with(coordinator));
    track_command_container(container_with(target));
    coordinator.raise(POOL, ONE_HOUR_MS);
    target.raise('identity', ONE_HOUR_MS);

    release_command_process_holds();

    expect(holds_process()).toBe(false);
    expect(target.is_cooling('identity')).toBe(true);
    target.clear();
  });

  it('does nothing when no coordinator is bound, or for one it does not own', () => {
    const host = { wait: vi.fn(), raise: vi.fn() } satisfies ThrottleCoordinator;
    const container = new Container();
    container.bind(THROTTLE_COORDINATOR_TOKEN).toConstantValue(host);

    expect(() => release_throttle_process_hold(new Container())).not.toThrow();
    expect(() => release_throttle_process_hold(container)).not.toThrow();
  });
});
