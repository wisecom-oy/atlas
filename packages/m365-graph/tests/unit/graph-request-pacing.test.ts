import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  run_with_request_pacing,
  run_with_throttle_coordinator,
} from '@wisecom/atlas-core/services/shared/graph-request-context';
import { InProcessThrottleCoordinator } from '@wisecom/atlas-core/services/shared/in-process-throttle-coordinator';
import { with_graph_retry } from '@/graph-request-error-handler';

const MINUTE_MS = 60_000;

function status_error(status: number): Record<string, unknown> {
  return { statusCode: status, message: `HTTP ${status}` };
}

/** A pacing hook whose `before_attempt` runs `wait` on every attempt. */
function fake_pacing(wait: () => Promise<void> = async () => {}) {
  return { before_attempt: vi.fn(wait), on_throttled: vi.fn() };
}

function after(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

describe('with_graph_retry pacing hook', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not charge pacing waits to the retry budget', async () => {
    // Three attempts at 25 minutes of pacing each is 75 minutes, past the 24 minute budget.
    const pacing = fake_pacing(() => after(25 * MINUTE_MS));
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(status_error(503))
      .mockRejectedValueOnce(status_error(503))
      .mockResolvedValue('ok');

    const result = run_with_request_pacing(pacing, () => with_graph_retry(fn));
    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);

    await expect(result).resolves.toBe('ok');
    expect(pacing.before_attempt).toHaveBeenCalledTimes(3);
  });

  it('tells the pacing hook about a 429 and not about other transient failures', async () => {
    const pacing = fake_pacing();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(status_error(503))
      .mockRejectedValueOnce(status_error(429))
      .mockResolvedValue('ok');

    const result = run_with_request_pacing(pacing, () => with_graph_retry(fn));
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    await expect(result).resolves.toBe('ok');
    expect(pacing.on_throttled).toHaveBeenCalledTimes(1);
  });

  it('waits out a cooldown raised while the request waited for its pacing slot', async () => {
    const coordinator = new InProcessThrottleCoordinator();
    // While this request waits 1 s for its slot, another request is throttled for 10 s.
    const pacing = fake_pacing(async () => {
      coordinator.raise('teams', 10_000);
      await after(1_000);
    });
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue('ok');

    const result = run_with_throttle_coordinator(coordinator, 'teams', () =>
      run_with_request_pacing(pacing, () => with_graph_retry(fn)),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toBe('ok');
    coordinator.clear();
  });
});
