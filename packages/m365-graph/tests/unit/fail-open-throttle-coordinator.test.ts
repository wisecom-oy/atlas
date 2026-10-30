import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThrottleCoordinator } from '@wisecom/atlas-types';
import { run_with_throttle_coordinator } from '@wisecom/atlas-core/services/shared/graph-request-context';
import { FailOpenThrottleCoordinator } from '@/fail-open-throttle-coordinator';
import { with_graph_retry } from '@/graph-request-error-handler';

const throttled = {
  statusCode: 429,
  message: 'Too Many Requests',
  headers: { 'retry-after': '2' },
};

describe('FailOpenThrottleCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets the request through when the host wait rejects', async () => {
    const host: ThrottleCoordinator = {
      wait: () => Promise.reject(new Error('shared state unreachable')),
      raise: () => undefined,
    };
    const coordinator = new FailOpenThrottleCoordinator(host);

    await expect(
      run_with_throttle_coordinator(coordinator, 'outlook', () =>
        with_graph_retry(async () => 'ok'),
      ),
    ).resolves.toBe('ok');
  });

  it('keeps retrying past a 429 when the host raise throws', async () => {
    const host: ThrottleCoordinator = {
      wait: async () => undefined,
      raise: () => {
        throw new Error('shared state unreachable');
      },
    };
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts === 1) throw throttled;
      return 'recovered';
    };

    const pending = run_with_throttle_coordinator(
      new FailOpenThrottleCoordinator(host),
      'outlook',
      () => with_graph_retry(fn),
    );
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('swallows a rejected promise returned from the host raise', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const host = {
      wait: async () => undefined,
      raise: () => Promise.reject(new Error('write failed')),
    } as unknown as ThrottleCoordinator;

    // Real timers: the rejection has to settle and Node has to get a turn to report it.
    vi.useRealTimers();
    new FailOpenThrottleCoordinator(host).raise('sharepoint_onedrive', 1_000);
    await new Promise((resolve) => setTimeout(resolve, 20));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('forwards to the host when it works', async () => {
    const host = { wait: vi.fn(async () => undefined), raise: vi.fn() };
    const coordinator = new FailOpenThrottleCoordinator(host);

    await coordinator.wait('identity');
    coordinator.raise('identity', 5_000);

    expect(host.wait).toHaveBeenCalledWith('identity');
    expect(host.raise).toHaveBeenCalledWith('identity', 5_000);
  });
});
