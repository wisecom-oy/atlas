import { Container } from 'inversify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THROTTLE_COORDINATOR_TOKEN } from '@wisecom/atlas-types';
import { EXIT_PARTIAL } from '@/command-run-outcome';
import { run_interruptible } from '@/adapters/interruptible-run';

/**
 * Issue #673: with the run's abort signal reaching Graph calls, Ctrl+C can now cut a run short
 * before it has a result to report. That is an interrupted run, not a failure, and the cooldown it
 * raised must not keep the process alive.
 */
function container_with_coordinator(on_deactivation: () => void): Container {
  const container = new Container();
  container
    .bind(THROTTLE_COORDINATOR_TOKEN)
    .toConstantValue({ wait: () => Promise.resolve(), raise: () => undefined });
  container.onDeactivation(THROTTLE_COORDINATOR_TOKEN, on_deactivation);
  container.get(THROTTLE_COORDINATOR_TOKEN);
  return container;
}

/** A run that rejects once its signal fires, the way a cancelled Graph wait does. */
function run_until_cancelled(signal: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('run_interruptible', () => {
  let previous_exit_code: typeof process.exitCode;
  let listeners_before: number;

  beforeEach(() => {
    previous_exit_code = process.exitCode;
    process.exitCode = undefined;
    listeners_before = process.listenerCount('SIGINT');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = previous_exit_code;
    vi.restoreAllMocks();
  });

  it('returns the result of a run that finished and removes its Ctrl+C listener', async () => {
    const result = await run_interruptible(new Container(), 'stopping', async () => 'done');

    expect(result).toBe('done');
    expect(process.exitCode).toBeUndefined();
    expect(process.listenerCount('SIGINT')).toBe(listeners_before);
  });

  it('reports a run cut short by Ctrl+C as interrupted and releases its cooldown', async () => {
    const cleared = vi.fn();
    const container = container_with_coordinator(cleared);

    const pending = run_interruptible(container, 'stopping', (gate) =>
      run_until_cancelled(gate.abort_signal),
    );
    process.emit('SIGINT');

    await expect(pending).resolves.toBeUndefined();
    expect(process.exitCode).toBe(EXIT_PARTIAL);
    expect(cleared).toHaveBeenCalledOnce();
    expect(process.listenerCount('SIGINT')).toBe(listeners_before);
  });

  it('rethrows a failure that was not caused by Ctrl+C', async () => {
    const cleared = vi.fn();
    const container = container_with_coordinator(cleared);

    await expect(
      run_interruptible(container, 'stopping', () => Promise.reject(new Error('Graph down'))),
    ).rejects.toThrow('Graph down');
    expect(cleared).not.toHaveBeenCalled();
    expect(process.listenerCount('SIGINT')).toBe(listeners_before);
  });
});
